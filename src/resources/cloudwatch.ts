/**
 * CloudWatch resource module.
 *
 * Manages two related concepts in one file because they share a client
 * boundary (CloudWatch Logs SDK + CloudWatch SDK) and almost always
 * appear together in real configs:
 *
 *   1. Log groups: explicit retention policy. Lambda log groups default
 *      to "Never expire" if AWS auto-creates them on first invocation,
 *      which is a real bill leak. Declaring them upfront with `retentionDays`
 *      pre-empts the default and lets Forge own KMS encryption settings.
 *
 *   2. Alarms: metric or composite alarms that page on threshold breaches.
 *      Common pattern: alarm action = SNS topic; configure alarmTopicName
 *      to wire it. Forge resolves bare topic names against the same config.
 *
 * SAFETY:
 *   - Log groups: data-tier (refuse destroy by default; logs may be
 *     forensically valuable).
 *   - Alarms: compute-tier (normal destroy).
 */

import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  AssociateKmsKeyCommand,
  DisassociateKmsKeyCommand,
  DeleteLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  type ComparisonOperator,
  type Statistic,
  type StateValue,
} from '@aws-sdk/client-cloudwatch';
import type { AwsContext } from '../aws.js';
import type {
  CloudWatchLogGroupConfig,
  CloudWatchAlarmConfig,
} from '../config.js';
import { getClient, withContext, canonicalize, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
// ===========================================================================
// LOG GROUPS
// ===========================================================================

export interface LogGroupState {
  name: string;
  arn: string;
  retentionDays: number;
  kmsKeyArn?: string;
}

const DEFAULT_LOG_RETENTION = 30;

export async function describeLogGroup(
  ctx: AwsContext,
  config: CloudWatchLogGroupConfig
): Promise<LogGroupState | null> {
  const logs: CloudWatchLogsClient = getClient(ctx, CloudWatchLogsClient);
  const res = await logs.send(new DescribeLogGroupsCommand({
    logGroupNamePrefix: config.name,
    limit: 50,
  }));
  // DescribeLogGroups uses prefix match; filter for exact.
  const exact = res.logGroups?.find(lg => lg.logGroupName === config.name);
  if (!exact) return null;
  return {
    name: exact.logGroupName!,
    arn: exact.arn ?? '',
    retentionDays: exact.retentionInDays ?? 0,  // 0 means "never expire"
    kmsKeyArn: exact.kmsKeyId,
  };
}

export async function planLogGroup(
  ctx: AwsContext,
  config: CloudWatchLogGroupConfig,
  _appName: string,
  plan: Plan
): Promise<LogGroupState | null> {
  const current = await describeLogGroup(ctx, config);
  const desiredRetention = config.retentionDays ?? DEFAULT_LOG_RETENTION;

  if (!current) {
    addChange(plan, {
      resourceType: 'log-group',
      resourceId: config.name,
      changeType: 'create',
      tier: 'data',
      fields: [
        { field: 'retentionDays', current: undefined, desired: desiredRetention },
        ...(config.kmsKeyArn ? [{ field: 'kmsKeyArn', current: undefined, desired: config.kmsKeyArn }] : []),
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.retentionDays !== desiredRetention) {
    fields.push({
      field: 'retentionDays',
      current: current.retentionDays === 0 ? 'never expire' : current.retentionDays,
      desired: desiredRetention,
    });
  }
  if ((config.kmsKeyArn ?? '') !== (current.kmsKeyArn ?? '')) {
    fields.push({ field: 'kmsKeyArn', current: current.kmsKeyArn ?? 'AWS-managed', desired: config.kmsKeyArn ?? 'AWS-managed' });
  }
  addChange(plan, {
    resourceType: 'log-group',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'data',
    fields,
  });
  return current;
}

export async function applyLogGroup(
  ctx: AwsContext,
  config: CloudWatchLogGroupConfig,
  _appName: string
): Promise<LogGroupState> {
  const logs: CloudWatchLogsClient = getClient(ctx, CloudWatchLogsClient);
  const desiredRetention = config.retentionDays ?? DEFAULT_LOG_RETENTION;

  let current = await describeLogGroup(ctx, config);
  if (!current) {
    console.log(`[log-group] Creating: ${config.name}`);
    try {
      await logs.send(new CreateLogGroupCommand({
        logGroupName: config.name,
        kmsKeyId: config.kmsKeyArn,
      }));
    } catch (err) {
      throw withContext(`[log-group] CreateLogGroup ${config.name}`, err);
    }
    current = (await describeLogGroup(ctx, config))!;
  }

  if (current.retentionDays !== desiredRetention) {
    console.log(`[log-group] ${config.name}: retention ${current.retentionDays || 'never'} -> ${desiredRetention} days`);
    await logs.send(new PutRetentionPolicyCommand({
      logGroupName: config.name,
      retentionInDays: desiredRetention,
    }));
    current.retentionDays = desiredRetention;
  }

  if ((config.kmsKeyArn ?? '') !== (current.kmsKeyArn ?? '')) {
    if (config.kmsKeyArn) {
      console.log(`[log-group] ${config.name}: associating KMS key`);
      await logs.send(new AssociateKmsKeyCommand({
        logGroupName: config.name,
        kmsKeyId: config.kmsKeyArn,
      }));
    } else if (current.kmsKeyArn) {
      console.log(`[log-group] ${config.name}: disassociating KMS key (back to AWS-managed)`);
      await logs.send(new DisassociateKmsKeyCommand({
        logGroupName: config.name,
      }));
    }
    current.kmsKeyArn = config.kmsKeyArn;
  }

  return current;
}

export async function destroyLogGroup(
  ctx: AwsContext,
  name: string,
  confirmDataLoss: boolean
): Promise<void> {
  if (!confirmDataLoss) {
    throw new ForgeRefusedError(
      `forge refuses to destroy log group '${name}' without --confirm-data-loss flag.\n` +
      'Logs are data-tier; deletion is irreversible. Re-run with --confirm-data-loss\n' +
      'to proceed.'
    );
  }
  const logs: CloudWatchLogsClient = getClient(ctx, CloudWatchLogsClient);
  await logs.send(new DeleteLogGroupCommand({ logGroupName: name }));
  console.log(`[log-group] Deleted: ${name}`);
  void DeleteRetentionPolicyCommand;  // keep import for future use
}

// ===========================================================================
// ALARMS
// ===========================================================================

export interface AlarmState {
  name: string;
  arn: string;
  state: string;
  threshold: number;
  comparisonOperator: string;
  metricName: string;
  namespace: string;
  alarmActions: string[];
}

/**
 * Resolve an alarm action: either a full ARN or a bare SNS topic name
 * (which Forge expands using the current account/region).
 */
function resolveAlarmAction(action: string, ctx: AwsContext): string {
  if (action.startsWith('arn:')) return action;
  return `arn:aws:sns:${ctx.region}:${ctx.accountId}:${action}`;
}

export async function describeAlarm(
  ctx: AwsContext,
  config: CloudWatchAlarmConfig
): Promise<AlarmState | null> {
  const cw: CloudWatchClient = getClient(ctx, CloudWatchClient);
  const res = await cw.send(new DescribeAlarmsCommand({
    AlarmNames: [config.name],
  }));
  const a = res.MetricAlarms?.[0];
  if (!a) return null;
  return {
    name: a.AlarmName!,
    arn: a.AlarmArn!,
    state: a.StateValue ?? 'INSUFFICIENT_DATA',
    threshold: a.Threshold ?? 0,
    comparisonOperator: a.ComparisonOperator ?? '',
    metricName: a.MetricName ?? '',
    namespace: a.Namespace ?? '',
    alarmActions: a.AlarmActions ?? [],
  };
}

export async function planAlarm(
  ctx: AwsContext,
  config: CloudWatchAlarmConfig,
  _appName: string,
  plan: Plan
): Promise<AlarmState | null> {
  const current = await describeAlarm(ctx, config);
  const desiredActions = config.alarmTopicName
    ? [resolveAlarmAction(config.alarmTopicName, ctx)]
    : [];

  if (!current) {
    addChange(plan, {
      resourceType: 'alarm',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [
        { field: 'metric', current: undefined, desired: `${config.namespace}/${config.metricName}` },
        { field: 'threshold', current: undefined, desired: `${config.comparisonOperator ?? 'GreaterThanThreshold'} ${config.threshold}` },
        ...(config.alarmTopicName ? [{ field: 'topic', current: undefined, desired: config.alarmTopicName }] : []),
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.threshold !== config.threshold) {
    fields.push({ field: 'threshold', current: current.threshold, desired: config.threshold });
  }
  const desiredOp = config.comparisonOperator ?? 'GreaterThanThreshold';
  if (current.comparisonOperator !== desiredOp) {
    fields.push({ field: 'comparisonOperator', current: current.comparisonOperator, desired: desiredOp });
  }
  if (canonicalize(current.alarmActions.slice().sort()) !== canonicalize(desiredActions.slice().sort())) {
    fields.push({
      field: 'alarmActions',
      current: current.alarmActions.length === 0 ? 'none' : `${current.alarmActions.length} action(s)`,
      desired: desiredActions.length === 0 ? 'none' : `${desiredActions.length} action(s)`,
    });
  }
  addChange(plan, {
    resourceType: 'alarm',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

export async function applyAlarm(
  ctx: AwsContext,
  config: CloudWatchAlarmConfig,
  _appName: string
): Promise<AlarmState> {
  const cw: CloudWatchClient = getClient(ctx, CloudWatchClient);
  const desiredActions = config.alarmTopicName
    ? [resolveAlarmAction(config.alarmTopicName, ctx)]
    : [];

  // PutMetricAlarm is upsert (idempotent); we always send the full
  // desired state. AWS preserves nothing about a previous alarm that
  // wasn't in this call, which is what we want for declarative config.
  console.log(`[alarm] Upsert: ${config.name}`);
  try {
    await cw.send(new PutMetricAlarmCommand({
      AlarmName: config.name,
      AlarmDescription: config.description,
      MetricName: config.metricName,
      Namespace: config.namespace,
      Statistic: (config.statistic ?? 'Average') as Statistic,
      Period: config.period ?? 300,
      EvaluationPeriods: config.evaluationPeriods ?? 1,
      Threshold: config.threshold,
      ComparisonOperator: (config.comparisonOperator ?? 'GreaterThanThreshold') as ComparisonOperator,
      Dimensions: config.dimensions
        ? Object.entries(config.dimensions).map(([Name, Value]) => ({ Name, Value }))
        : undefined,
      AlarmActions: desiredActions.length > 0 ? desiredActions : undefined,
      OKActions: desiredActions.length > 0 ? desiredActions : undefined,
      TreatMissingData: config.treatMissingData ?? 'notBreaching',
    }));
  } catch (err) {
    throw withContext(`[alarm] PutMetricAlarm ${config.name}`, err);
  }

  const desc = await describeAlarm(ctx, config);
  return desc ?? {
    name: config.name,
    arn: '',
    state: 'INSUFFICIENT_DATA' as StateValue,
    threshold: config.threshold,
    comparisonOperator: config.comparisonOperator ?? 'GreaterThanThreshold',
    metricName: config.metricName,
    namespace: config.namespace,
    alarmActions: desiredActions,
  };
}

export async function destroyAlarm(ctx: AwsContext, name: string): Promise<void> {
  const cw: CloudWatchClient = getClient(ctx, CloudWatchClient);
  await cw.send(new DeleteAlarmsCommand({ AlarmNames: [name] }));
  console.log(`[alarm] Deleted: ${name}`);
}
