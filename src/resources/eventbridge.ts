/**
 * EventBridge rules + targets resource module.
 *
 * Manages rules (schedule-driven or pattern-driven) attached to either
 * the default bus or a custom bus declared in the same config. Each rule
 * has one Lambda target today; the underlying API supports multiple
 * targets per rule but the typical pattern in our stacks is 1:1.
 *
 * Adoption-safe: existing rules with the same (bus, name) pair are
 * adopted in place. Targets and Lambda invoke permissions are reconciled
 * idempotently — Forge adds missing, leaves extras alone.
 *
 * Distinct from `event-bus.ts` which manages buses themselves. Rules
 * depend on buses, so engine ordering runs eventBuses before
 * eventbridge.
 *
 * SAFETY: Compute-tier — destroy removes the rule + its targets.
 * Doesn't touch the underlying Lambda or its invoke permission grant.
 */

import {
  EventBridgeClient,
  DescribeRuleCommand,
  PutRuleCommand,
  DeleteRuleCommand,
  ListTargetsByRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  EnableRuleCommand,
  DisableRuleCommand,
} from '@aws-sdk/client-eventbridge';
import {
  LambdaClient,
  AddPermissionCommand,
  GetPolicyCommand,
} from '@aws-sdk/client-lambda';
import type { AwsContext } from '../aws.js';
import type { EventBridgeRuleConfig } from '../config.js';
import { getClient, withContext, lambdaName, toLambdaArn, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface EventBridgeRuleState {
  name: string;
  arn: string;
  eventBusName: string;
  state: 'ENABLED' | 'DISABLED';
  schedule?: string;
  eventPattern?: object;
  targetLambdaName?: string;
}

const DEFAULT_BUS = 'default';

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeEventBridge(
  ctx: AwsContext,
  config: EventBridgeRuleConfig
): Promise<EventBridgeRuleState | null> {
  const eb: EventBridgeClient = getClient(ctx, EventBridgeClient);
  const busName = config.eventBusName ?? DEFAULT_BUS;

  try {
    const rule = await eb.send(new DescribeRuleCommand({
      Name: config.name,
      EventBusName: busName,
    }));
    const targets = await eb.send(new ListTargetsByRuleCommand({
      Rule: config.name,
      EventBusName: busName,
    }));
    const firstTarget = targets.Targets?.[0];
    return {
      name: rule.Name!,
      arn: rule.Arn!,
      eventBusName: busName,
      state: (rule.State as 'ENABLED' | 'DISABLED') ?? 'ENABLED',
      schedule: rule.ScheduleExpression,
      eventPattern: rule.EventPattern ? JSON.parse(rule.EventPattern) : undefined,
      targetLambdaName: lambdaName(firstTarget?.Arn),
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planEventBridge(
  ctx: AwsContext,
  config: EventBridgeRuleConfig,
  _appName: string,
  plan: Plan
): Promise<EventBridgeRuleState | null> {
  const current = await describeEventBridge(ctx, config);
  const desiredState = (config.enabled ?? true) ? 'ENABLED' : 'DISABLED';
  const desiredTarget = lambdaName(config.targetLambda);

  if (!current) {
    addChange(plan, {
      resourceType: 'eventbridge',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [
        { field: 'bus', current: undefined, desired: config.eventBusName ?? DEFAULT_BUS },
        ...(config.schedule ? [{ field: 'schedule', current: undefined, desired: config.schedule }] : []),
        { field: 'targetLambda', current: undefined, desired: desiredTarget },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

  if (config.schedule && current.schedule !== config.schedule) {
    fields.push({ field: 'schedule', current: current.schedule, desired: config.schedule });
  }
  if (config.eventPattern && canonicalize(current.eventPattern ?? {}) !== canonicalize(config.eventPattern)) {
    fields.push({ field: 'eventPattern', current: '(differs)', desired: '(config)' });
  }
  if (current.state !== desiredState) {
    fields.push({ field: 'state', current: current.state, desired: desiredState });
  }
  // Target drift: only meaningful if the live target is a Lambda. Rules
  // can target SQS / Kinesis / Step Functions / etc.; Forge's config
  // currently only models Lambda targets, so when the live target is
  // anything else, the rule is effectively non-Lambda-managed and we
  // skip the target drift check. Detect Lambda targets by looking for
  // a bare function name (no colons — lambdaName() collapses Lambda
  // ARNs to the bare name, non-Lambda ARNs keep their `arn:aws:...` form).
  const liveTargetIsLambda =
    !!current.targetLambdaName &&
    !current.targetLambdaName.includes(':');
  if (liveTargetIsLambda && current.targetLambdaName !== desiredTarget) {
    fields.push({ field: 'targetLambda', current: current.targetLambdaName ?? '(none)', desired: desiredTarget });
  }

  addChange(plan, {
    resourceType: 'eventbridge',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyEventBridge(
  ctx: AwsContext,
  config: EventBridgeRuleConfig,
  _appName: string
): Promise<EventBridgeRuleState> {
  const eb: EventBridgeClient = getClient(ctx, EventBridgeClient);
  const lambdaClient: LambdaClient = getClient(ctx, LambdaClient);
  const busName = config.eventBusName ?? DEFAULT_BUS;
  const desiredState = (config.enabled ?? true) ? 'ENABLED' : 'DISABLED';

  console.log(`[eventbridge] Upsert rule: ${config.name} (bus=${busName})`);
  let ruleArn: string;
  try {
    const res = await eb.send(new PutRuleCommand({
      Name: config.name,
      EventBusName: busName,
      ScheduleExpression: config.schedule,
      EventPattern: config.eventPattern ? JSON.stringify(config.eventPattern) : undefined,
      State: desiredState,
    }));
    ruleArn = res.RuleArn!;
  } catch (err) {
    throw withContext(`[eventbridge] PutRule ${config.name}`, err);
  }

  // State drift (PutRule sets State, but if config wants disabled we still
  // call DisableRule explicitly, PutRule's State arg is sometimes finicky
  // when transitioning from a different existing state). Silent catch is
  // wrong here: an IAM denial or a missing rule would have masked the real
  // problem and made the whole apply look successful.
  try {
    if (desiredState === 'DISABLED') {
      await eb.send(new DisableRuleCommand({ Name: config.name, EventBusName: busName }));
    } else {
      await eb.send(new EnableRuleCommand({ Name: config.name, EventBusName: busName }));
    }
  } catch (err) {
    throw withContext(`[eventbridge] ${desiredState === 'DISABLED' ? 'DisableRule' : 'EnableRule'} ${config.name}`, err);
  }

  // Target sync. EventBridge targets carry an ID per target; Forge always
  // uses '1' for the single Lambda target, which makes apply idempotent
  // (the same ID maps to the same target slot and PutTargets is upsert).
  //
  // Adoption guard: if the rule already has a non-Lambda target (SQS DLQ,
  // Step Functions state machine, Kinesis stream, etc.), don't overwrite
  // it with a Lambda target. Forge's schema only models Lambda targets;
  // forcing a Lambda target onto a rule that legitimately targets
  // something else would silently break the rule's purpose. Plan also
  // skips the drift check for the same reason.
  const lambdaArn = toLambdaArn(config.targetLambda, ctx.region, ctx.accountId);
  const liveTargets = await eb.send(new ListTargetsByRuleCommand({
    Rule: config.name,
    EventBusName: busName,
  }));
  const liveNonLambdaTarget = liveTargets.Targets?.find(
    t => t.Arn && !t.Arn.includes(':function:')
  );
  if (liveNonLambdaTarget) {
    console.log(`[eventbridge] ${config.name}: live target is non-Lambda (${liveNonLambdaTarget.Arn}); leaving as-is. Forge config's targetLambda not applied.`);
    return {
      name: config.name,
      arn: ruleArn,
      eventBusName: busName,
      state: desiredState,
      schedule: config.schedule,
      eventPattern: config.eventPattern,
      targetLambdaName: lambdaName(liveNonLambdaTarget.Arn),
    };
  }
  const existingMatch = liveTargets.Targets?.find(t => t.Arn === lambdaArn);

  if (!existingMatch) {
    console.log(`[eventbridge] ${config.name}: setting target → ${config.targetLambda}`);
    try {
      await eb.send(new PutTargetsCommand({
        Rule: config.name,
        EventBusName: busName,
        Targets: [{
          Id: '1',
          Arn: lambdaArn,
          Input: config.input,
        }],
      }));
    } catch (err) {
      throw withContext(`[eventbridge] PutTargets ${config.name}`, err);
    }
  }

  // Grant EventBridge invoke permission on the Lambda. Forge dedupes via
  // GetPolicy so re-runs are idempotent.
  const statementId = `eventbridge-${config.name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  let alreadyGranted = false;
  try {
    const policy = await lambdaClient.send(new GetPolicyCommand({
      FunctionName: lambdaArn,
    }));
    const policyDoc = JSON.parse(policy.Policy!);
    alreadyGranted = policyDoc.Statement?.some(
      (s: any) => s.Sid === statementId &&
                  s.Condition?.ArnLike?.['AWS:SourceArn'] === ruleArn
    );
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') {
      // Unexpected error reading the policy; fall through to permission grant.
    }
  }
  if (!alreadyGranted) {
    try {
      await lambdaClient.send(new AddPermissionCommand({
        FunctionName: lambdaArn,
        StatementId: statementId,
        Action: 'lambda:InvokeFunction',
        Principal: 'events.amazonaws.com',
        SourceArn: ruleArn,
      }));
      console.log(`[eventbridge] ${config.name}: granted invoke permission to events.amazonaws.com`);
    } catch (err: any) {
      if (err.name !== 'ResourceConflictException' && err.name !== 'ResourceNotFoundException') {
        console.log(`[eventbridge] Warning: could not grant invoke for ${config.name}: ${err.message}`);
      }
    }
  }

  return {
    name: config.name,
    arn: ruleArn,
    eventBusName: busName,
    state: desiredState,
    schedule: config.schedule,
    eventPattern: config.eventPattern,
    targetLambdaName: lambdaName(config.targetLambda),
  };
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyEventBridge(ctx: AwsContext, name: string): Promise<void> {
  const eb: EventBridgeClient = getClient(ctx, EventBridgeClient);
  // Find the rule on default bus first; user can pass a custom bus by
  // including it in the resource name (`bus:rulename`) — uncommon enough
  // to defer until requested.
  let busName = DEFAULT_BUS;
  let ruleName = name;
  if (name.includes(':')) [busName, ruleName] = name.split(':', 2);

  // Targets must be removed before the rule itself.
  const targets = await eb.send(new ListTargetsByRuleCommand({
    Rule: ruleName,
    EventBusName: busName,
  })).catch(() => undefined);
  const targetIds = (targets?.Targets ?? []).map(t => t.Id!).filter(Boolean);
  if (targetIds.length > 0) {
    await eb.send(new RemoveTargetsCommand({
      Rule: ruleName,
      EventBusName: busName,
      Ids: targetIds,
    }));
  }
  await eb.send(new DeleteRuleCommand({
    Name: ruleName,
    EventBusName: busName,
  }));
  console.log(`[eventbridge] Deleted rule: ${ruleName}`);
}
