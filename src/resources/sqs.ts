/**
 * SQS resource module.
 *
 * Manages SQS queues (standard and FIFO).
 *
 * SAFETY: Compute-tier — normal destroy.
 */

import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  CreateQueueCommand,
  SetQueueAttributesCommand,
  type QueueAttributeName,
} from '@aws-sdk/client-sqs';
import type { AwsContext } from '../aws.js';
import type { SqsQueueConfig } from '../config.js';
import { getClient, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface SqsState {
  queueUrl: string;
  queueArn: string;
  approximateMessages: number;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeSqs(
  ctx: AwsContext,
  config: SqsQueueConfig,
  appName: string
): Promise<SqsState | null> {
  const sqs = getClient(ctx, SQSClient);

  try {
    const urlRes = await sqs.send(new GetQueueUrlCommand({ QueueName: config.name }));
    if (!urlRes.QueueUrl) return null;

    const attrRes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: urlRes.QueueUrl,
      AttributeNames: ['QueueArn', 'ApproximateNumberOfMessages'],
    }));

    return {
      queueUrl: urlRes.QueueUrl,
      queueArn: attrRes.Attributes?.QueueArn ?? '',
      approximateMessages: parseInt(attrRes.Attributes?.ApproximateNumberOfMessages ?? '0', 10),
    };
  } catch (err: any) {
    if (err.name === 'QueueDoesNotExist' || err.name === 'AWS.SimpleQueueService.NonExistentQueue') {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Build the SQS queue attribute map from config. Only sets attributes that have
 * an explicit config value — AWS preserves anything we don't include.
 */
function buildAttributes(config: SqsQueueConfig, accountId: string, region: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (config.retentionDays !== undefined) {
    attrs.MessageRetentionPeriod = String(config.retentionDays * 86400);
  }
  if (config.visibilityTimeout !== undefined) {
    attrs.VisibilityTimeout = String(config.visibilityTimeout);
  }
  if (config.encryption !== false) {
    attrs.SqsManagedSseEnabled = 'true';
  }
  if (config.dlqName) {
    const dlqArn = `arn:aws:sqs:${region}:${accountId}:${config.dlqName}`;
    attrs.RedrivePolicy = JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: config.maxReceiveCount ?? 3,
    });
  }
  return attrs;
}

/**
 * Read the queue's live attributes and return the subset that differs from
 * config. Returns an empty object if the queue is in sync.
 */
async function computeSqsDrift(
  sqs: SQSClient,
  queueUrl: string,
  desiredAttrs: Record<string, string>
): Promise<Record<string, string>> {
  if (Object.keys(desiredAttrs).length === 0) return {};
  const currentAttrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: Object.keys(desiredAttrs) as QueueAttributeName[],
  }));
  const current = (currentAttrs.Attributes ?? {}) as Record<string, string>;
  const drift: Record<string, string> = {};
  for (const [k, v] of Object.entries(desiredAttrs)) {
    if (current[k] !== v) drift[k] = v;
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planSqs(
  ctx: AwsContext,
  config: SqsQueueConfig,
  appName: string,
  plan: Plan
): Promise<SqsState | null> {
  const sqs = getClient(ctx, SQSClient);
  const current = await describeSqs(ctx, config, appName);

  if (!current) {
    addChange(plan, {
      resourceType: 'sqs',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'retentionDays', current: undefined, desired: config.retentionDays ?? 4 },
        { field: 'fifo', current: undefined, desired: config.fifo ?? false },
        ...(config.dlqName ? [{ field: 'redrivePolicy', current: undefined, desired: `dlq=${config.dlqName}, maxReceive=${config.maxReceiveCount ?? 3}` }] : []),
      ],
    });
    return null;
  }

  // Existing queue: compute attribute drift.
  const desiredAttrs = buildAttributes(config, ctx.accountId, ctx.region);
  const drift = await computeSqsDrift(sqs, current.queueUrl, desiredAttrs);
  if (Object.keys(drift).length === 0) {
    addChange(plan, {
      resourceType: 'sqs',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
  } else {
    const fields = Object.entries(drift).map(([k, v]) => ({
      field: k,
      current: '(differs)',
      desired: v,
    }));
    addChange(plan, {
      resourceType: 'sqs',
      resourceId: config.name,
      changeType: 'update',
      tier: 'compute',
      fields,
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applySqs(
  ctx: AwsContext,
  config: SqsQueueConfig,
  _appName: string
): Promise<SqsState> {
  const sqs: SQSClient = getClient(ctx, SQSClient);
  const existing = await describeSqs(ctx, config, _appName);

  if (existing) {
    // Apply only drifted attributes. SetQueueAttributes is partial so this
    // is safe even when AWS has fields we don't manage.
    const desiredAttrs = buildAttributes(config, ctx.accountId, ctx.region);
    try {
      const drift = await computeSqsDrift(sqs, existing.queueUrl, desiredAttrs);
      if (Object.keys(drift).length > 0) {
        console.log(`[sqs] ${config.name}: updating ${Object.keys(drift).join(', ')}`);
        await sqs.send(new SetQueueAttributesCommand({
          QueueUrl: existing.queueUrl,
          Attributes: drift,
        }));
      }
    } catch (err: any) {
      console.log(`[sqs] Warning: could not check/update attributes for ${config.name}: ${err.message}`);
    }
    return existing;
  }

  // Create new queue. FIFO queue names must end with .fifo.
  const queueName = config.fifo && !config.name.endsWith('.fifo') ? `${config.name}.fifo` : config.name;
  const createAttrs = buildAttributes(config, ctx.accountId, ctx.region);
  if (config.fifo) {
    createAttrs.FifoQueue = 'true';
  }

  console.log(`[sqs] Creating queue: ${queueName}`);
  const createRes = await sqs.send(new CreateQueueCommand({
    QueueName: queueName,
    Attributes: Object.keys(createAttrs).length > 0 ? createAttrs : undefined,
  }));

  const queueUrl = createRes.QueueUrl!;
  const attrRes = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['QueueArn'],
  }));

  console.log(`[sqs] Created: ${attrRes.Attributes?.QueueArn}`);
  return {
    queueUrl,
    queueArn: attrRes.Attributes?.QueueArn ?? '',
    approximateMessages: 0,
  };
}

export async function destroySqs(name: string): Promise<never> {
  throw new ForgeRefusedError(
    `forge refuses to destroy SQS queue '${name}'. In-flight messages would be lost.\n` +
    `Drain the queue first (verify ApproximateNumberOfMessages = 0), then delete via\n` +
    `AWS Console or CLI manually.`
  );
}
