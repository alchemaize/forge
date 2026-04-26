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
} from '@aws-sdk/client-sfn';
import type { AwsContext } from '../aws.js';
import type { StepFunctionConfig } from '../config.js';
import { getClient } from '../aws.js';
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
  const current = await describeStepFunction(ctx, config, appName);

  if (current) {
    addChange(plan, {
      resourceType: 'step-functions',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

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

// ---------------------------------------------------------------------------
// Apply — placeholder (read-only adoption for now)
// ---------------------------------------------------------------------------

export async function applyStepFunction(
  ctx: AwsContext,
  config: StepFunctionConfig,
  appName: string
): Promise<StepFunctionState | null> {
  const existing = await describeStepFunction(ctx, config, appName);
  if (existing) {
    console.log(`[step-functions] ${config.name} — ${existing.status} (${existing.type})`);
    return existing;
  }

  console.log(`[step-functions] ${config.name} — not found. Create via AWS Console or extend this module.`);
  return null;
}
