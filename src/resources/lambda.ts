/**
 * Lambda resource module.
 *
 * Handles function creation, configuration updates, and code deployment.
 * Drift detection on memory, timeout, runtime, env vars, and role.
 */

import {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  AddPermissionCommand,
  GetPolicyCommand,
  GetFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  ListEventSourceMappingsCommand,
  CreateEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
  waitUntilFunctionUpdatedV2,
  waitUntilFunctionActiveV2,
  type Runtime,
} from '@aws-sdk/client-lambda';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { AwsContext } from '../aws.js';
import type { LambdaFunctionConfig, InlinePolicyStatement } from '../config.js';
import { isNamedInlinePolicy } from '../config.js';
import type { VpcState } from './vpc.js';
import { getClient, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface LambdaState {
  functionName: string;
  functionArn: string;
  runtime: string;
  memory: number;
  timeout: number;
  roleArn: string;
  codeSize: number;
  lastModified: string;
  /** Current environment variables. Used by applyLambda to merge with config.env
   * so env vars not in config are preserved (avoids wiping secrets on update). */
  env: Record<string, string>;
  /** VPC subnets the Lambda is currently attached to. Empty array = not in VPC. */
  vpcSubnetIds: string[];
  /** VPC security groups the Lambda is currently attached to. */
  vpcSecurityGroupIds: string[];
  /** "arm64" or "x86_64". Matches the Architectures array's first entry. */
  architecture: 'arm64' | 'x86_64';
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeLambda(
  ctx: AwsContext,
  functionName: string
): Promise<LambdaState | null> {
  const lambda = getClient(ctx, LambdaClient);

  try {
    const res = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
    const cfg = res.Configuration!;
    return {
      functionName: cfg.FunctionName!,
      functionArn: cfg.FunctionArn!,
      runtime: cfg.Runtime ?? 'unknown',
      memory: cfg.MemorySize ?? 128,
      timeout: cfg.Timeout ?? 3,
      roleArn: cfg.Role ?? '',
      codeSize: cfg.CodeSize ?? 0,
      lastModified: cfg.LastModified ?? '',
      env: cfg.Environment?.Variables ?? {},
      vpcSubnetIds: cfg.VpcConfig?.SubnetIds ?? [],
      vpcSecurityGroupIds: cfg.VpcConfig?.SecurityGroupIds ?? [],
      architecture: (cfg.Architectures?.[0] ?? 'arm64') as 'arm64' | 'x86_64',
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planLambda(
  ctx: AwsContext,
  config: LambdaFunctionConfig,
  appName: string,
  plan: Plan
): Promise<LambdaState | null> {
  const current = await describeLambda(ctx, config.name);

  if (current) {
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
    // Preserve current when not specified. Plan must match apply behavior.
    const desiredRuntime = config.runtime ?? current.runtime;
    const desiredMemory = config.memory ?? current.memory;
    const desiredTimeout = config.timeout ?? current.timeout;
    // Desired role: explicit config wins. Otherwise preserve the current role
    // (matches applyLambda behavior — no silent role swap on adoption).
    const desiredRoleArn = config.roleArn ?? current.roleArn;

    if (current.runtime !== desiredRuntime) {
      fields.push({ field: 'runtime', current: current.runtime, desired: desiredRuntime });
    }
    if (current.memory !== desiredMemory) {
      fields.push({ field: 'memory', current: current.memory, desired: desiredMemory });
    }
    if (current.timeout !== desiredTimeout) {
      fields.push({ field: 'timeout', current: current.timeout, desired: desiredTimeout });
    }
    if (current.roleArn !== desiredRoleArn) {
      fields.push({ field: 'roleArn', current: current.roleArn, desired: desiredRoleArn });
    }
    if (config.architecture && current.architecture !== config.architecture) {
      // Architecture changes require a fresh code upload built for the
      // target arch; we surface drift but apply will not flip it without
      // a zipPath (the existing code is built for the wrong arch).
      fields.push({
        field: 'architecture',
        current: current.architecture,
        desired: `${config.architecture} (requires fresh zipPath)`,
      });
    }

    // Check env var drift if env vars are specified in config
    if (config.env) {
      const lambdaClient = getClient(ctx, LambdaClient);
      try {
        const detail = await lambdaClient.send(new GetFunctionCommand({ FunctionName: config.name }));
        const currentEnv = detail.Configuration?.Environment?.Variables ?? {};
        for (const [key, desiredVal] of Object.entries(config.env)) {
          if (currentEnv[key] !== desiredVal) {
            fields.push({ field: `env.${key}`, current: currentEnv[key] ?? '(unset)', desired: desiredVal });
          }
        }
      } catch {
        // Can't check env vars — skip
      }
    }

    addChange(plan, {
      resourceType: 'lambda',
      resourceId: config.name,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'compute',
      fields,
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'lambda',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'runtime', current: undefined, desired: config.runtime ?? 'nodejs22.x' },
      { field: 'memory', current: undefined, desired: config.memory ?? 512 },
      { field: 'timeout', current: undefined, desired: config.timeout ?? 30 },
      { field: 'architecture', current: undefined, desired: config.architecture ?? 'arm64' },
      { field: 'roleArn', current: undefined, desired: config.roleArn ?? `(generated: ${config.name}-role)` },
      { field: 'vpc', current: undefined, desired: config.vpc ?? false },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Sync Lambda event source mappings to match config.
 *
 * Behavior:
 *   - For each source in config: ensure a mapping exists. Create if missing,
 *     update batchSize/window if drift, no-op if in sync.
 *   - Existing mappings not in config are PRESERVED (adoption-safe). Never auto-deletes.
 *
 * Used for SQS → Lambda, Kinesis → Lambda, DynamoDB Streams → Lambda.
 */
async function syncEventSources(
  ctx: AwsContext,
  functionName: string,
  config: LambdaFunctionConfig
): Promise<void> {
  if (!config.eventSources?.length) return;

  const lambda: LambdaClient = getClient(ctx, LambdaClient);

  let existingMappings: Array<{ UUID?: string; EventSourceArn?: string; BatchSize?: number; MaximumBatchingWindowInSeconds?: number }> = [];
  try {
    const res = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: functionName }));
    existingMappings = res.EventSourceMappings ?? [];
  } catch (err: any) {
    console.log(`[lambda] Warning: could not list event sources for ${functionName}: ${err.message}`);
    return;
  }

  for (const src of config.eventSources) {
    const sourceArn = src.source;
    const existing = existingMappings.find(m => m.EventSourceArn === sourceArn);
    const desiredBatchSize = src.batchSize;
    const desiredWindow = src.maximumBatchingWindowInSeconds;

    if (!existing) {
      console.log(`[lambda] Creating event source mapping: ${sourceArn.split(':').pop()} → ${functionName}`);
      const createInput: any = {
        FunctionName: functionName,
        EventSourceArn: sourceArn,
      };
      if (desiredBatchSize !== undefined) createInput.BatchSize = desiredBatchSize;
      if (desiredWindow !== undefined) createInput.MaximumBatchingWindowInSeconds = desiredWindow;
      if (src.reportBatchItemFailures) {
        createInput.FunctionResponseTypes = ['ReportBatchItemFailures'];
      }
      await lambda.send(new CreateEventSourceMappingCommand(createInput));
    } else {
      // Update if batchSize or window differs.
      const needsUpdate =
        (desiredBatchSize !== undefined && existing.BatchSize !== desiredBatchSize) ||
        (desiredWindow !== undefined && existing.MaximumBatchingWindowInSeconds !== desiredWindow);
      if (needsUpdate) {
        console.log(`[lambda] Updating event source mapping: ${sourceArn.split(':').pop()}`);
        const updateInput: any = { UUID: existing.UUID };
        if (desiredBatchSize !== undefined) updateInput.BatchSize = desiredBatchSize;
        if (desiredWindow !== undefined) updateInput.MaximumBatchingWindowInSeconds = desiredWindow;
        await lambda.send(new UpdateEventSourceMappingCommand(updateInput));
      }
    }
  }
}

/**
 * Sync the Lambda's Function URL to match config.
 *
 * Behavior:
 *   - config.functionUrl set → ensure URL exists with that auth + CORS. Create if missing,
 *     update if drift, no-op if already in sync.
 *   - config.functionUrl unset → leave any existing URL alone. Adoption-safe; Forge never
 *     deletes URLs even if config changes (manual delete only, since URLs may be in
 *     external code).
 *
 * For URL with AuthType=NONE, AWS Lambda also requires a resource policy permission
 * granting Function URL invoke (StatementId 'FunctionURLAllowPublicAccess'). Forge
 * adds this when creating a new public URL.
 */
async function syncFunctionUrl(
  ctx: AwsContext,
  config: LambdaFunctionConfig
): Promise<void> {
  if (!config.functionUrl) return;

  const lambda: LambdaClient = getClient(ctx, LambdaClient);
  const desiredAuth = config.functionUrl.authType ?? 'NONE';
  const desiredCors = config.functionUrl.cors ? {
    AllowOrigins: config.functionUrl.cors.allowOrigins,
    AllowMethods: config.functionUrl.cors.allowMethods,
    AllowHeaders: config.functionUrl.cors.allowHeaders,
    AllowCredentials: config.functionUrl.cors.allowCredentials,
    MaxAge: config.functionUrl.cors.maxAge,
    ExposeHeaders: config.functionUrl.cors.exposeHeaders,
  } : undefined;

  let existing: { AuthType?: string; FunctionUrl?: string } | null = null;
  try {
    existing = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: config.name }));
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }

  if (!existing) {
    console.log(`[lambda] Creating Function URL for ${config.name} (${desiredAuth})`);
    await lambda.send(new CreateFunctionUrlConfigCommand({
      FunctionName: config.name,
      AuthType: desiredAuth as 'NONE' | 'AWS_IAM',
      Cors: desiredCors,
    }));
    // For public URLs, Lambda requires a resource-based policy permission.
    if (desiredAuth === 'NONE') {
      try {
        await lambda.send(new AddPermissionCommand({
          FunctionName: config.name,
          StatementId: 'FunctionURLAllowPublicAccess',
          Action: 'lambda:InvokeFunctionUrl',
          Principal: '*',
          FunctionUrlAuthType: 'NONE',
        }));
        console.log(`[lambda] Added FunctionURL public-access permission`);
      } catch (err: any) {
        if (err.name !== 'ResourceConflictException') {
          console.log(`[lambda] Warning: could not add FunctionURL permission: ${err.message}`);
        }
      }
    }
    return;
  }

  // Existing URL — update if auth or cors differ.
  if (existing.AuthType !== desiredAuth) {
    console.log(`[lambda] Updating Function URL for ${config.name}: auth ${existing.AuthType} → ${desiredAuth}`);
    await lambda.send(new UpdateFunctionUrlConfigCommand({
      FunctionName: config.name,
      AuthType: desiredAuth as 'NONE' | 'AWS_IAM',
      Cors: desiredCors,
    }));
  }
  // CORS drift detection is intentionally omitted — comparing nested objects is
  // error-prone, and CORS misconfig usually doesn't break things silently the way
  // an auth change does. Manual update via AWS CLI/Console for CORS tweaks.
}

/**
 * Sync IAM policies on the Lambda's execution role to match config.
 *
 * Additive only — never detaches existing managed policies and never deletes existing
 * inline policies. This is critical for adoption: a CDK-created role typically has
 * an inline policy named like `Stack-FnServiceRoleDefaultPolicy-XYZ` plus the managed
 * `AWSLambdaBasicExecutionRole`. Forge doesn't try to take ownership of those.
 *
 * What Forge DOES manage:
 *   - config.policies (managed policy ARNs) → AttachRolePolicy if not already attached
 *   - config.inlinePolicies (statement array) → PutRolePolicy with name 'forge-inline'
 *     (single Forge-owned policy, additive to whatever CFN/CDK has on the role)
 *
 * On apply, the merged result on the live role is: CFN-managed policies + Forge-managed
 * `forge-inline` policy. Both grant access; neither overrides the other.
 */
async function syncRolePolicies(
  ctx: AwsContext,
  roleArn: string,
  config: LambdaFunctionConfig
): Promise<void> {
  if (!config.policies?.length && !config.inlinePolicies?.length) return;

  const iam = getClient(ctx, IAMClient);
  const roleName = roleArn.split('/').pop();
  if (!roleName) return;

  // Sync managed policies (attach if missing — additive, no detach).
  if (config.policies?.length) {
    let currentArns = new Set<string>();
    try {
      const res = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
      currentArns = new Set((res.AttachedPolicies ?? []).map(p => p.PolicyArn!).filter(Boolean));
    } catch (err: any) {
      console.log(`[lambda] Warning: could not list attached policies for ${roleName}: ${err.message}`);
      return;
    }
    for (const arn of config.policies) {
      if (!currentArns.has(arn)) {
        console.log(`[lambda] Attaching managed policy to ${roleName}: ${arn.split('/').pop()}`);
        await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: arn }));
      }
    }
  }

  // Sync inline policies. Each entry is either:
  //   - { name, statements: [...] } — written as a named policy via PutRolePolicy
  //   - { effect, actions, resources } (flat) — auto-grouped into 'forge-inline'
  // Flat-form entries with no name share a single 'forge-inline' policy.
  // Named-form entries map 1:1 with their own PolicyName, so Forge can fully OWN
  // CDK-named policies (captured during import) instead of duplicating them.
  if (config.inlinePolicies?.length) {
    const grouped: Map<string, Array<{ effect: string; actions: string[]; resources: string[]; sid?: string; conditions?: unknown }>> = new Map();
    for (const p of config.inlinePolicies) {
      if (isNamedInlinePolicy(p)) {
        // Named-form: explicit policy name with multiple statements.
        grouped.set(p.name, p.statements);
      } else {
        // Flat-form: single statement to be merged into 'forge-inline'.
        const list = grouped.get('forge-inline') ?? [];
        list.push({
          effect: p.effect,
          actions: p.actions,
          resources: p.resources,
        });
        grouped.set('forge-inline', list);
      }
    }
    for (const [policyName, statements] of grouped) {
      const desiredDoc = {
        Version: '2012-10-17',
        Statement: statements.map(s => {
          const stmt: Record<string, unknown> = {
            Effect: s.effect,
            Action: s.actions,
            Resource: s.resources,
          };
          if (s.sid) stmt.Sid = s.sid;
          if (s.conditions) stmt.Condition = s.conditions;
          return stmt;
        }),
      };

      // Skip PUT if the current policy already matches. With inline policies imported
      // for every Lambda, applies would otherwise log "Syncing inline policy" 30+ times
      // per run even when nothing changed. AWS treats matching PUTs as no-ops, but the
      // log noise is misleading and the round-trip is wasteful on large stacks.
      try {
        const currentRes = await iam.send(new GetRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
        }));
        if (currentRes.PolicyDocument) {
          const currentDocStr = decodeURIComponent(currentRes.PolicyDocument);
          // Normalize current and desired through stringify with sorted keys for stable compare.
          if (canonicalize(JSON.parse(currentDocStr)) === canonicalize(desiredDoc)) {
            continue;
          }
        }
      } catch (err: any) {
        if (err.name !== 'NoSuchEntityException') {
          // Don't fail apply on a transient read error — fall through to PUT.
          console.log(`[lambda] Note: could not read current policy ${policyName}, proceeding with PUT: ${err.message}`);
        }
      }

      console.log(`[lambda] Syncing inline policy on ${roleName}: ${policyName} (${statements.length} statements)`);
      await iam.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(desiredDoc),
      }));
    }
  }
}

async function ensureExecutionRole(
  ctx: AwsContext,
  appName: string,
  functionName: string,
  config: LambdaFunctionConfig
): Promise<string> {
  const iam = getClient(ctx, IAMClient);
  const roleName = `${functionName}-role`;

  try {
    const res = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    console.log(`[lambda] IAM role exists: ${roleName}`);
    return res.Role!.Arn!;
  } catch (err: any) {
    if (err.name !== 'NoSuchEntityException') throw err;
  }

  console.log(`[lambda] Creating IAM role: ${roleName}`);
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });

  const createRes = await iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: trustPolicy,
    Description: `Lambda execution role for ${functionName}`,
    Tags: [{ Key: 'app', Value: appName }, { Key: 'managed-by', Value: 'forge' }],
  }));
  const roleArn = createRes.Role!.Arn!;

  // Attach basic execution policy
  const policies = [
    'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
  ];
  if (config.vpc) {
    policies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole');
  }
  for (const policyArn of [...policies, ...(config.policies ?? [])]) {
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
  }

  // Inline policies on a freshly-created role.
  //
  // Earlier this path only handled flat-form entries on greenfield, with
  // the comment that "new roles created from scratch shouldn't have
  // CDK-named policies to worry about." That was wrong: a config with
  // named-form inline policies (the recommended form, and the import
  // round-trip shape) would create a brand-new role with NO inline
  // policies, leaving the function under-privileged on first invoke
  // until a follow-up apply ran syncRolePolicies. Now we apply both
  // forms here so the role is fully-formed at create time.
  if (config.inlinePolicies?.length) {
    const grouped = new Map<string, Array<InlinePolicyStatement>>();
    for (const p of config.inlinePolicies) {
      if (isNamedInlinePolicy(p)) {
        grouped.set(p.name, p.statements);
      } else {
        const list = grouped.get('forge-inline') ?? [];
        list.push({ effect: p.effect, actions: p.actions, resources: p.resources });
        grouped.set('forge-inline', list);
      }
    }
    for (const [policyName, statements] of grouped) {
      const doc = {
        Version: '2012-10-17',
        Statement: statements.map(s => {
          const stmt: Record<string, unknown> = {
            Effect: s.effect,
            Action: s.actions,
            Resource: s.resources,
          };
          if (s.sid) stmt.Sid = s.sid;
          if (s.conditions) stmt.Condition = s.conditions;
          return stmt;
        }),
      };
      await iam.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(doc),
      }));
    }
  }

  // Wait for propagation
  console.log('[lambda] Waiting for IAM role propagation (10s)...');
  await new Promise(r => setTimeout(r, 10000));

  return roleArn;
}

export async function applyLambda(
  ctx: AwsContext,
  config: LambdaFunctionConfig,
  appName: string,
  vpcState?: VpcState
): Promise<LambdaState> {
  const lambda = getClient(ctx, LambdaClient);
  const current = await describeLambda(ctx, config.name);

  // Determine the desired role ARN.
  // Priority: explicit config.roleArn > preserve current role on adoption > create/find managed role.
  // Adoption path is critical: CDK-created functions have roles like "Stack-FnServiceRole-XYZ",
  // not "{fnName}-role". Without this branch, Forge would create a fresh role and swap the
  // function over to it, losing every custom IAM permission attached by CDK.
  let roleArn: string;
  if (config.roleArn) {
    roleArn = config.roleArn;
  } else if (current) {
    roleArn = current.roleArn;
  } else {
    roleArn = await ensureExecutionRole(ctx, appName, config.name, config);
  }

  // Sync IAM policies on the role (additive — never detaches existing CFN-owned policies).
  // Lets users add new permissions via Forge config without losing CDK-managed ones.
  await syncRolePolicies(ctx, roleArn, config);

  // Sync Function URL if config specifies one. Adoption-safe: existing URLs are preserved
  // when config.functionUrl is unset.
  await syncFunctionUrl(ctx, config);

  // Sync event source mappings (SQS, Kinesis, DynamoDB Streams → this Lambda).
  // Adoption-safe: existing mappings not in config are preserved.
  await syncEventSources(ctx, config.name, config);

  // Preserve current values when config doesn't specify a value (adoption safety).
  // Otherwise a minimal config like `{ name, runtime: 'nodejs22.x' }` would silently
  // reset memory to 512 and timeout to 30 on every adopted function. Defaults only
  // apply when the function doesn't exist yet (greenfield create).
  const runtime = config.runtime ?? current?.runtime ?? 'nodejs22.x';
  const memory = config.memory ?? current?.memory ?? 512;
  const timeout = config.timeout ?? current?.timeout ?? 30;
  const architecture = config.architecture ?? 'arm64';

  // Lambda env handling: AWS UpdateFunctionConfiguration with `Environment` REPLACES
  // all env vars (not merge). Three rules to keep adoption safe:
  //   1. If config.env is undefined → omit Environment entirely → AWS preserves all current env.
  //   2. If config.env is defined → MERGE with current env (config wins for matching keys).
  //      This means user-specified vars get applied without wiping secrets that aren't in config.
  //   3. REDACTED placeholder values are refused — these come from forge import for secret-
  //      pattern keys and would silently overwrite production secrets if applied.
  let environment: { Variables: Record<string, string> } | undefined;
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      if (typeof v === 'string' && v.includes('REDACTED')) {
        throw new Error(
          `[lambda] ${config.name}: env var ${k} has a REDACTED placeholder value. ` +
          `Set the actual value in config or remove this key entirely (apply will then preserve the live value).`
        );
      }
    }
    const currentEnv = current?.env ?? {};
    // Only include Environment in the update if config.env actually differs from current.
    // Otherwise apply would send a no-op UpdateFunctionConfiguration and log "Updating..."
    // when nothing's actually changing. For new functions (no current) always include.
    const envChanging = !current || Object.entries(config.env).some(([k, v]) => currentEnv[k] !== v);
    if (envChanging) {
      environment = { Variables: { ...currentEnv, ...config.env } };
    }
  }

  // VPC config. Three states matter:
  //   1. Config wants VPC + we have vpcState  -> attach (or update) VpcConfig
  //   2. Config does NOT want VPC + Lambda is currently in a VPC -> detach
  //      by sending empty arrays. AWS Lambda's API treats empty arrays as
  //      "remove me from the VPC."
  //   3. Config does not want VPC and Lambda isn't in one -> omit field
  //      entirely so the API doesn't think we're trying to change anything.
  // Earlier the omit-when-undefined path silently kept Lambdas in the VPC
  // forever; user couldn't remove `vpc: true` from config.
  let vpcConfig: { SubnetIds: string[]; SecurityGroupIds: string[] } | undefined;
  if (config.vpc && vpcState) {
    const subnetIds = vpcState.privateSubnetIds.length > 0
      ? vpcState.privateSubnetIds
      : vpcState.publicSubnetIds;
    const sgIds = vpcState.securityGroupIds.lambda
      ? [vpcState.securityGroupIds.lambda]
      : [vpcState.securityGroupIds.default];
    vpcConfig = { SubnetIds: subnetIds, SecurityGroupIds: sgIds };
  }

  if (current) {
    // Check for config drift
    const roleChanging = current.roleArn !== roleArn;
    const needsVpcDetach = !config.vpc && current.vpcSubnetIds.length > 0;
    const needsConfigUpdate =
      current.runtime !== runtime ||
      current.memory !== memory ||
      current.timeout !== timeout ||
      roleChanging ||
      needsVpcDetach;

    if (needsConfigUpdate || environment) {
      console.log(`[lambda] Updating ${config.name} configuration${needsVpcDetach ? ' (detaching from VPC)' : ''}`);
      // Only include Role in the update if it's actually changing.
      // Omitting Role preserves the existing role per AWS Lambda's "fields you don't
      // specify are preserved" behavior. This is the safety net for adoption.
      // For VPC: send the desired config when attaching, empty arrays when
      // detaching, and omit the field entirely otherwise.
      const vpcUpdate = vpcConfig
        ? { VpcConfig: vpcConfig }
        : needsVpcDetach
          ? { VpcConfig: { SubnetIds: [], SecurityGroupIds: [] } }
          : {};
      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: config.name,
        Runtime: runtime as Runtime,
        MemorySize: memory,
        Timeout: timeout,
        Environment: environment,
        Layers: config.layers,
        ...(roleChanging ? { Role: roleArn } : {}),
        ...vpcUpdate,
      }));

      // Wait for update
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: config.name }
      );
      console.log(`[lambda] Configuration updated`);
    } else {
      console.log(`[lambda] ${config.name} — no config changes`);
    }

    return current;
  }

  // Create new function
  // Placeholder code — real code deployed via forge deploy or deploy scripts
  const placeholderCode = Buffer.from(
    'export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ status: "placeholder" }) });',
    'utf-8'
  );

  // Create a minimal zip
  const { execSync } = await import('child_process');
  const tmpDir = `/tmp/forge-lambda-${config.name}`;
  const { mkdirSync, writeFileSync } = await import('fs');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(`${tmpDir}/index.mjs`, placeholderCode);
  execSync(`cd '${tmpDir}' && zip -q lambda.zip index.mjs`);
  const zipBuffer = readFileSync(`${tmpDir}/lambda.zip`);

  console.log(`[lambda] Creating function: ${config.name}`);
  const createRes = await lambda.send(new CreateFunctionCommand({
    FunctionName: config.name,
    Runtime: runtime as Runtime,
    Handler: config.handler ?? 'index.handler',
    Role: roleArn,
    Code: { ZipFile: zipBuffer },
    MemorySize: memory,
    Timeout: timeout,
    Architectures: [architecture],
    Environment: environment,
    Layers: config.layers,
    ...(vpcConfig ? { VpcConfig: vpcConfig } : {}),
    Tags: {
      app: appName,
      'managed-by': 'forge',
    },
  }));

  await waitUntilFunctionActiveV2(
    { client: lambda, maxWaitTime: 120 },
    { FunctionName: config.name }
  );

  // Cleanup
  execSync(`rm -rf '${tmpDir}'`);

  console.log(`[lambda] Created: ${config.name}`);

  return {
    functionName: config.name,
    functionArn: createRes.FunctionArn!,
    runtime,
    memory,
    timeout,
    roleArn,
    codeSize: zipBuffer.length,
    lastModified: new Date().toISOString(),
    env: environment?.Variables ?? {},
    vpcSubnetIds: vpcConfig?.SubnetIds ?? [],
    vpcSecurityGroupIds: vpcConfig?.SecurityGroupIds ?? [],
    architecture,
  };
}

/**
 * Deploy code to an existing Lambda (fast path — no infra changes).
 */
export async function deployLambdaCode(
  ctx: AwsContext,
  functionName: string,
  zipPath: string
): Promise<void> {
  const lambda = getClient(ctx, LambdaClient);

  if (!existsSync(zipPath)) {
    throw new Error(`Zip file not found: ${zipPath}`);
  }

  const zipBuffer = readFileSync(zipPath);
  console.log(`[lambda] Deploying code to ${functionName} (${(zipBuffer.length / 1024).toFixed(0)}KB)`);

  await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    ZipFile: zipBuffer,
  }));

  await waitUntilFunctionUpdatedV2(
    { client: lambda, maxWaitTime: 120 },
    { FunctionName: functionName }
  );

  console.log(`[lambda] Code deployed to ${functionName}`);
}

export async function destroyLambda(
  ctx: AwsContext,
  functionName: string
): Promise<void> {
  const lambda = getClient(ctx, LambdaClient);
  const { DeleteFunctionCommand } = await import('@aws-sdk/client-lambda');

  console.log(`[lambda] Deleting function: ${functionName}`);
  await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
  console.log(`[lambda] Deleted: ${functionName}`);
}
