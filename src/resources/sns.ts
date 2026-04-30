/**
 * SNS topic resource module.
 *
 * Manages standalone SNS topics (standard or FIFO) with attached
 * subscriptions. Common use cases:
 *   - Alarm fanout: CloudWatch alarms publish here, subscribers fan out
 *     to email / Slack / Lambda.
 *   - Async fanout from API Gateway / EventBridge.
 *   - Mobile push platforms (APNS / GCM endpoints).
 *
 * Adoption-safe behavior:
 *   - Existing topics with the same name are adopted in place.
 *   - Subscriptions outside the config are LEFT ALONE. Forge only adds
 *     missing subscriptions; it never revokes existing ones, since the
 *     SubscriptionArn isn't predictable from name and a stray manual
 *     subscription shouldn't get yanked silently.
 *
 * SAFETY: Compute-tier — destroy refused (subscriptions outside config
 * could go offline if the topic is deleted; manual cleanup is correct).
 */

import {
  SNSClient,
  ListTopicsCommand,
  GetTopicAttributesCommand,
  CreateTopicCommand,
  SetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SubscribeCommand,
} from '@aws-sdk/client-sns';
import type { AwsContext } from '../aws.js';
import type { SnsTopicConfig, SnsSubscriptionConfig } from '../config.js';
import { getClient, withContext, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface SnsTopicState {
  topicArn: string;
  name: string;
  displayName: string;
  fifo: boolean;
  subscriptionCount: number;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

function topicArnFor(ctx: AwsContext, topicName: string): string {
  return `arn:aws:sns:${ctx.region}:${ctx.accountId}:${topicName}`;
}

export async function describeSns(
  ctx: AwsContext,
  config: SnsTopicConfig
): Promise<SnsTopicState | null> {
  const sns = getClient(ctx, SNSClient);
  const topicName = config.fifo && !config.name.endsWith('.fifo')
    ? `${config.name}.fifo`
    : config.name;
  const arn = topicArnFor(ctx, topicName);

  try {
    const attrs = await sns.send(new GetTopicAttributesCommand({ TopicArn: arn }));
    if (!attrs.Attributes) return null;
    const subsRes = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn }));
    return {
      topicArn: arn,
      name: topicName,
      displayName: attrs.Attributes.DisplayName ?? '',
      fifo: attrs.Attributes.FifoTopic === 'true',
      subscriptionCount: subsRes.Subscriptions?.length ?? 0,
    };
  } catch (err: any) {
    if (err.name === 'NotFound' || err.name === 'NotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Resolve a subscription endpoint to its delivered shape. SQS / Lambda
 * accept either bare names (resolved against the same forge config /
 * account) or full ARNs. Email / SMS / HTTP pass through as-is.
 */
function resolveEndpoint(sub: SnsSubscriptionConfig, ctx: AwsContext): string {
  const e = sub.endpoint;
  if (e.startsWith('arn:')) return e;
  if (sub.protocol === 'sqs') return `arn:aws:sqs:${ctx.region}:${ctx.accountId}:${e}`;
  if (sub.protocol === 'lambda') return `arn:aws:lambda:${ctx.region}:${ctx.accountId}:function:${e}`;
  return e;
}

export async function planSns(
  ctx: AwsContext,
  config: SnsTopicConfig,
  _appName: string,
  plan: Plan
): Promise<SnsTopicState | null> {
  const current = await describeSns(ctx, config);

  if (!current) {
    addChange(plan, {
      resourceType: 'sns',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'fifo', current: undefined, desired: config.fifo ?? false },
        { field: 'subscriptions', current: undefined, desired: config.subscriptions?.length ?? 0 },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

  // Display name drift
  if (config.displayName !== undefined && current.displayName !== config.displayName) {
    fields.push({ field: 'displayName', current: current.displayName, desired: config.displayName });
  }

  // Subscription drift: count missing subscriptions (resolved endpoint not present)
  if (config.subscriptions?.length) {
    const sns = getClient(ctx, SNSClient);
    const subsRes = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: current.topicArn }));
    const liveEndpoints = new Set(
      (subsRes.Subscriptions ?? [])
        .filter(s => s.SubscriptionArn !== 'PendingConfirmation')
        .map(s => `${s.Protocol}|${s.Endpoint}`)
    );
    const missing = config.subscriptions.filter(sub => {
      const sig = `${sub.protocol}|${resolveEndpoint(sub, ctx)}`;
      return !liveEndpoints.has(sig);
    });
    if (missing.length > 0) {
      fields.push({
        field: 'subscriptions',
        current: `${current.subscriptionCount} live`,
        desired: `+${missing.length} to add`,
      });
    }
  }

  addChange(plan, {
    resourceType: 'sns',
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

export async function applySns(
  ctx: AwsContext,
  config: SnsTopicConfig,
  _appName: string
): Promise<SnsTopicState> {
  const sns = getClient(ctx, SNSClient);
  const topicName = config.fifo && !config.name.endsWith('.fifo')
    ? `${config.name}.fifo`
    : config.name;

  let topicArn: string;
  const existing = await describeSns(ctx, config);

  if (existing) {
    topicArn = existing.topicArn;
    console.log(`[sns] Topic exists: ${topicName}`);
    // Apply attribute drift (display name, KMS key).
    if (config.displayName !== undefined && existing.displayName !== config.displayName) {
      console.log(`[sns] ${topicName}: setting DisplayName`);
      await sns.send(new SetTopicAttributesCommand({
        TopicArn: topicArn,
        AttributeName: 'DisplayName',
        AttributeValue: config.displayName,
      }));
    }
  } else {
    console.log(`[sns] Creating topic: ${topicName}`);
    try {
      const attrs: Record<string, string> = {};
      if (config.fifo) attrs.FifoTopic = 'true';
      if (config.displayName) attrs.DisplayName = config.displayName;
      if (config.kmsKeyId) attrs.KmsMasterKeyId = config.kmsKeyId;
      const res = await sns.send(new CreateTopicCommand({
        Name: topicName,
        Attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
      }));
      topicArn = res.TopicArn!;
      console.log(`[sns] Created: ${topicArn}`);
    } catch (err) {
      throw withContext(`[sns] CreateTopic ${topicName}`, err);
    }
  }

  // Sync subscriptions: add missing, leave extras alone.
  if (config.subscriptions?.length) {
    const subsRes = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    const liveEndpoints = new Set(
      (subsRes.Subscriptions ?? [])
        .filter(s => s.SubscriptionArn !== 'PendingConfirmation')
        .map(s => `${s.Protocol}|${s.Endpoint}`)
    );
    for (const sub of config.subscriptions) {
      const endpoint = resolveEndpoint(sub, ctx);
      const sig = `${sub.protocol}|${endpoint}`;
      if (liveEndpoints.has(sig)) continue;
      console.log(`[sns] ${topicName}: subscribing ${sub.protocol}:${endpoint}`);
      const attributes: Record<string, string> = {};
      if (sub.rawMessageDelivery) attributes.RawMessageDelivery = 'true';
      if (sub.filterPolicy) attributes.FilterPolicy = JSON.stringify(sub.filterPolicy);
      try {
        await sns.send(new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: sub.protocol,
          Endpoint: endpoint,
          Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
          ReturnSubscriptionArn: true,
        }));
      } catch (err) {
        throw withContext(`[sns] Subscribe ${sub.protocol}:${endpoint}`, err);
      }
    }
  }

  const finalSubs = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
  return {
    topicArn,
    name: topicName,
    displayName: config.displayName ?? existing?.displayName ?? '',
    fifo: !!config.fifo,
    subscriptionCount: finalSubs.Subscriptions?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Destroy (refused)
// ---------------------------------------------------------------------------

export async function destroySns(name: string): Promise<never> {
  throw new ForgeRefusedError(
    `forge refuses to destroy SNS topic '${name}'. Subscribers (email, Lambda, SQS) would silently lose delivery.\n` +
    'Confirm no subscribers depend on the topic, then DeleteTopic via AWS Console or CLI manually.'
  );
}
