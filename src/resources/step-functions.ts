/**
 * Step Functions resource module.
 *
 * Manages state machines. Supports STANDARD and EXPRESS types.
 *
 * SAFETY: Compute-tier — normal destroy.
 */

import {
  SFNClient,
  ListStateMachinesCommand,
  DescribeStateMachineCommand,
  CreateStateMachineCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import type { AwsContext } from '../aws.js';
import type { StepFunctionConfig } from '../config.js';
import { getClient, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface StepFunctionState {
  stateMachineArn: string;
  name: string;
  status: string;
  type: string;
  roleArn: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeStepFunction(
  ctx: AwsContext,
  config: StepFunctionConfig,
  appName: string
): Promise<StepFunctionState | null> {
  const sfn = getClient(ctx, SFNClient);

  // List state machines and find by name
  const listRes = await sfn.send(new ListStateMachinesCommand({ maxResults: 100 }));
  const match = listRes.stateMachines?.find(sm => sm.name === config.name);

  if (!match) return null;

  try {
    const desc = await sfn.send(new DescribeStateMachineCommand({
      stateMachineArn: match.stateMachineArn,
    }));

    return {
      stateMachineArn: desc.stateMachineArn!,
      name: desc.name!,
      status: desc.status ?? 'ACTIVE',
      type: desc.type ?? 'STANDARD',
      roleArn: desc.roleArn!,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planStepFunction(
  ctx: AwsContext,
  config: StepFunctionConfig,
  appName: string,
  plan: Plan
): Promise<StepFunctionState | null> {
  const sfn = getClient(ctx, SFNClient);
  const current = await describeStepFunction(ctx, config, appName);

  if (!current) {
    addChange(plan, {
      resourceType: 'step-functions',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'type', current: undefined, desired: config.type ?? 'STANDARD' },
        { field: 'timeout', current: undefined, desired: `${config.timeout ?? 5}m` },
      ],
    });
    return null;
  }

  // Existing state machine: check definition drift.
  const fields: { field: string; current: any; desired: any }[] = [];
  if (config.definition) {
    try {
      const desc = await sfn.send(new DescribeStateMachineCommand({
        stateMachineArn: current.stateMachineArn,
      }));
      const currentDef = desc.definition ? JSON.parse(desc.definition) : {};
      if (canonicalize(currentDef) !== canonicalize(config.definition)) {
        fields.push({
          field: 'definition',
          current: '(differs)',
          desired: '(config)',
        });
      }
    } catch {
      /* describe failed; report as unchanged so apply can re-check */
    }
  }
  if (config.type && current.type !== config.type) {
    fields.push({ field: 'type', current: current.type, desired: config.type });
  }

  addChange(plan, {
    resourceType: 'step-functions',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Ensure an IAM role for the state machine to assume. Trust policy allows
 * states.amazonaws.com to assume. Inline policy grants invoke on the target Lambdas
 * referenced by the state machine definition (best-effort — uses wildcard for the
 * account's Lambdas, which the user can tighten manually).
 */
async function ensureStateMachineRole(
  ctx: AwsContext,
  config: StepFunctionConfig
): Promise<string> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  const roleName = `${config.name}-execution-role`;
  const roleArn = `arn:aws:iam::${ctx.accountId}:role/${roleName}`;

  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
    return roleArn;
  } catch (err: any) {
    if (err.name !== 'NoSuchEntityException') throw err;
  }

  console.log(`[step-functions] Creating execution role: ${roleName}`);
  await iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'states.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    }),
  }));

  // Default inline policy grants invoke on all Lambdas in the account (broad — user
  // can tighten via Forge config in a follow-up apply once the state machine exists).
  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: 'forge-default-invoke',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['lambda:InvokeFunction'],
        Resource: `arn:aws:lambda:${ctx.region}:${ctx.accountId}:function:*`,
      }],
    }),
  }));

  // Wait for IAM propagation — Step Functions checks role existence on create.
  await new Promise(r => setTimeout(r, 10000));
  return roleArn;
}

export async function applyStepFunction(
  ctx: AwsContext,
  config: StepFunctionConfig,
  appName: string
): Promise<StepFunctionState> {
  const sfn: SFNClient = getClient(ctx, SFNClient);
  const existing = await describeStepFunction(ctx, config, appName);

  if (existing) {
    console.log(`[step-functions] ${config.name} — ${existing.status} (${existing.type})`);
    // Update definition if config has one and it differs from current.
    if (config.definition) {
      try {
        const desc = await sfn.send(new DescribeStateMachineCommand({
          stateMachineArn: existing.stateMachineArn,
        }));
        const currentDef = desc.definition ? JSON.parse(desc.definition) : {};
        // Use canonicalize so whitespace and key-order differences don't
        // trigger spurious updates.
        if (canonicalize(currentDef) !== canonicalize(config.definition)) {
          console.log(`[step-functions] ${config.name}: updating definition`);
          await sfn.send(new UpdateStateMachineCommand({
            stateMachineArn: existing.stateMachineArn,
            definition: JSON.stringify(config.definition),
          }));
        }
      } catch (err: any) {
        console.log(`[step-functions] Warning: could not check/update definition: ${err.message}`);
      }
    }
    return existing;
  }

  if (!config.definition) {
    throw new Error(
      `[step-functions] ${config.name}: state machine doesn't exist and config has no 'definition'. ` +
      `Add the Amazon States Language JSON to config.definition before applying.`
    );
  }

  const roleArn = await ensureStateMachineRole(ctx, config);

  console.log(`[step-functions] Creating state machine: ${config.name}`);
  const createRes = await sfn.send(new CreateStateMachineCommand({
    name: config.name,
    definition: JSON.stringify(config.definition),
    roleArn,
    type: (config.type ?? 'STANDARD') as 'STANDARD' | 'EXPRESS',
    loggingConfiguration: config.logLevel ? {
      level: config.logLevel as 'ALL' | 'ERROR' | 'FATAL' | 'OFF',
      includeExecutionData: true,
    } : undefined,
    tracingConfiguration: { enabled: config.tracing ?? false },
  }));

  console.log(`[step-functions] Created: ${createRes.stateMachineArn}`);
  return {
    stateMachineArn: createRes.stateMachineArn!,
    name: config.name,
    status: 'ACTIVE',
    type: config.type ?? 'STANDARD',
    roleArn,
  };
}

export async function destroyStepFunction(ctx: AwsContext, name: string): Promise<void> {
  const sfn: SFNClient = getClient(ctx, SFNClient);
  // Find the state machine ARN by name (cli only knows the name).
  const list = await sfn.send(new ListStateMachinesCommand({ maxResults: 100 }));
  const match = list.stateMachines?.find(sm => sm.name === name);
  if (!match) {
    throw new Error(`[step-functions] State machine '${name}' not found.`);
  }
  const { DeleteStateMachineCommand } = await import('@aws-sdk/client-sfn');
  await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: match.stateMachineArn }));
  console.log(`[step-functions] Deleted: ${name}`);
}
