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
} from '@aws-sdk/client-sqs';
import type { AwsContext } from '../aws.js';
import type { SqsQueueConfig } from '../config.js';
import { getClient } from '../aws.js';
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
// Plan
// ---------------------------------------------------------------------------

export async function planSqs(
  ctx: AwsContext,
  config: SqsQueueConfig,
  appName: string,
  plan: Plan
): Promise<SqsState | null> {
  const current = await describeSqs(ctx, config, appName);

  if (current) {
    addChange(plan, {
      resourceType: 'sqs',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'sqs',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'retentionDays', current: undefined, desired: config.retentionDays ?? 4 },
      { field: 'fifo', current: undefined, desired: config.fifo ?? false },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply — placeholder (read-only adoption for now)
// ---------------------------------------------------------------------------

export async function applySqs(
  ctx: AwsContext,
  config: SqsQueueConfig,
  appName: string
): Promise<SqsState | null> {
  const existing = await describeSqs(ctx, config, appName);
  if (existing) {
    console.log(`[sqs] ${config.name} — ${existing.approximateMessages} messages`);
    return existing;
  }

  console.log(`[sqs] ${config.name} — not found. Create via AWS Console or extend this module.`);
  return null;
}
