/**
 * Custom EventBridge EventBus resource module.
 *
 * AWS provides a 'default' bus per account/region; user-defined buses are needed
 * when isolating events between apps or when cross-account routing is configured.
 * yeon-crm has 'yeon-crm-events'; tanaiger has its own. EventBridge Rules can
 * target either the default bus or a custom one — Forge's existing eventbridge
 * resource handles rules; this module handles the buses they live on.
 *
 * Forge doesn't auto-delete buses — they may have rules attached.
 */

import {
  EventBridgeClient,
  DescribeEventBusCommand,
  CreateEventBusCommand,
} from '@aws-sdk/client-eventbridge';
import type { AwsContext } from '../aws.js';
import type { EventBusConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface EventBusState {
  name: string;
  arn: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeEventBus(
  ctx: AwsContext,
  config: EventBusConfig
): Promise<EventBusState | null> {
  const eb: EventBridgeClient = getClient(ctx, EventBridgeClient);

  try {
    const res = await eb.send(new DescribeEventBusCommand({ Name: config.name }));
    return {
      name: res.Name ?? config.name,
      arn: res.Arn ?? '',
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planEventBus(
  ctx: AwsContext,
  config: EventBusConfig,
  _appName: string,
  plan: Plan
): Promise<EventBusState | null> {
  const current = await describeEventBus(ctx, config);
  if (current) {
    addChange(plan, {
      resourceType: 'event-bus',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'config',
      fields: [],
    });
    return current;
  }
  addChange(plan, {
    resourceType: 'event-bus',
    resourceId: config.name,
    changeType: 'create',
    tier: 'config',
    fields: [{ field: 'name', current: undefined, desired: config.name }],
  });
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyEventBus(
  ctx: AwsContext,
  config: EventBusConfig,
  _appName: string
): Promise<EventBusState> {
  const eb: EventBridgeClient = getClient(ctx, EventBridgeClient);
  const existing = await describeEventBus(ctx, config);

  if (existing) {
    return existing;
  }

  console.log(`[event-bus] Creating: ${config.name}`);
  const res = await eb.send(new CreateEventBusCommand({ Name: config.name }));
  return {
    name: config.name,
    arn: res.EventBusArn ?? '',
  };
}

export async function destroyEventBus(): Promise<never> {
  throw new Error(
    'forge refuses to destroy custom EventBuses. Rules attached to the bus would lose their target.\n' +
    'Migrate or delete the rules first, then DeleteEventBus via AWS Console or CLI.'
  );
}
