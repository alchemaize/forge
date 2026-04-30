/**
 * Custom EventBridge EventBus resource module.
 *
 * AWS provides a 'default' bus per account/region. User-defined buses
 * are useful when:
 *   - Isolating events between apps that share an account (yeon-crm has
 *     'yeon-crm-events'; tanaiger has its own).
 *   - Cross-account routing (EventBridge can route from one bus in
 *     account A to another bus in account B with a Bus-as-target rule).
 *   - Workload isolation (a bus failure shouldn't take down unrelated
 *     workloads — practically rare but the architectural reason exists).
 *
 * Adoption-safe: buses adopt by name; create when missing. Buses are
 * immutable after create — there's no Modify/Update API for the bus
 * itself, so there's nothing to drift.
 *
 * Companion module: `eventbridge.ts` manages the rules and targets that
 * live on the bus. They're separate so a config can declare buses
 * without rules (or vice versa for the default bus).
 *
 * SAFETY: Config-tier — destroy refused. Rules attached to the bus
 * lose their target on delete and the events go nowhere; manual
 * cleanup via Console is the right path.
 */

import {
  EventBridgeClient,
  DescribeEventBusCommand,
  CreateEventBusCommand,
} from '@aws-sdk/client-eventbridge';
import type { AwsContext } from '../aws.js';
import type { EventBusConfig } from '../config.js';
import { getClient, ForgeRefusedError } from '../aws.js';
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
  throw new ForgeRefusedError(
    'forge refuses to destroy custom EventBuses. Rules attached to the bus would lose their target.\n' +
    'Migrate or delete the rules first, then DeleteEventBus via AWS Console or CLI.'
  );
}
