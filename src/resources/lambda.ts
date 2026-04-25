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
} from '@aws-sdk/client-iam';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { AwsContext } from '../aws.js';
import type { LambdaFunctionConfig } from '../config.js';
import type { VpcState } from './vpc.js';
import { getClient } from '../aws.js';
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
    const desiredRuntime = config.runtime ?? 'nodejs20.x';
    const desiredMemory = config.memory ?? 512;
    const desiredTimeout = config.timeout ?? 30;

    if (current.runtime !== desiredRuntime) {
      fields.push({ field: 'runtime', current: current.runtime, desired: desiredRuntime });
    }
    if (current.memory !== desiredMemory) {
      fields.push({ field: 'memory', current: current.memory, desired: desiredMemory });
    }
    if (current.timeout !== desiredTimeout) {
      fields.push({ field: 'timeout', current: current.timeout, desired: desiredTimeout });
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
      { field: 'runtime', current: undefined, desired: config.runtime ?? 'nodejs20.x' },
      { field: 'memory', current: undefined, desired: config.memory ?? 512 },
      { field: 'timeout', current: undefined, desired: config.timeout ?? 30 },
      { field: 'architecture', current: undefined, desired: config.architecture ?? 'arm64' },
      { field: 'vpc', current: undefined, desired: config.vpc ?? false },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

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

  // Inline policies
  if (config.inlinePolicies?.length) {
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: 'forge-inline',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: config.inlinePolicies.map(p => ({
          Effect: p.effect,
          Action: p.actions,
          Resource: p.resources,
        })),
      }),
    }));
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

  const roleArn = await ensureExecutionRole(ctx, appName, config.name, config);
  const runtime = config.runtime ?? 'nodejs20.x';
  const memory = config.memory ?? 512;
  const timeout = config.timeout ?? 30;
  const architecture = config.architecture ?? 'arm64';

  const environment = config.env ? { Variables: config.env } : undefined;

  // VPC config
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
    const needsConfigUpdate =
      current.runtime !== runtime ||
      current.memory !== memory ||
      current.timeout !== timeout;

    if (needsConfigUpdate || environment) {
      console.log(`[lambda] Updating ${config.name} configuration`);
      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: config.name,
        Runtime: runtime as Runtime,
        MemorySize: memory,
        Timeout: timeout,
        Role: roleArn,
        Environment: environment,
        Layers: config.layers,
        ...(vpcConfig ? { VpcConfig: vpcConfig } : {}),
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
