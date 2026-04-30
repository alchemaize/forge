/**
 * Pinpoint (mobile push, analytics) resource module.
 *
 * Minimal management: lookup by name, create if missing. Forge tracks the AppId
 * so other resources (Lambda env vars referencing PINPOINT_APP_ID) can be wired up.
 *
 * Doesn't manage channels (APNS/GCM credentials, SMS sender IDs) — those involve
 * external secrets/certificates and are better handled out-of-band via Console.
 */

import {
  PinpointClient,
  GetAppsCommand,
  CreateAppCommand,
} from '@aws-sdk/client-pinpoint';
import type { AwsContext } from '../aws.js';
import type { PinpointAppConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface PinpointState {
  appId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describePinpoint(
  ctx: AwsContext,
  config: PinpointAppConfig
): Promise<PinpointState | null> {
  const pp: PinpointClient = getClient(ctx, PinpointClient);

  let nextToken: string | undefined;
  do {
    const res = await pp.send(new GetAppsCommand({ Token: nextToken, PageSize: '100' }));
    const match = res.ApplicationsResponse?.Item?.find((a: any) => a.Name === config.name);
    if (match?.Id) return { appId: match.Id, name: config.name };
    nextToken = res.ApplicationsResponse?.NextToken;
  } while (nextToken);

  return null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planPinpoint(
  ctx: AwsContext,
  config: PinpointAppConfig,
  _appName: string,
  plan: Plan
): Promise<PinpointState | null> {
  const current = await describePinpoint(ctx, config);

  if (current) {
    addChange(plan, {
      resourceType: 'pinpoint',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'pinpoint',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [{ field: 'name', current: undefined, desired: config.name }],
  });
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyPinpoint(
  ctx: AwsContext,
  config: PinpointAppConfig,
  _appName: string
): Promise<PinpointState> {
  const pp: PinpointClient = getClient(ctx, PinpointClient);
  const existing = await describePinpoint(ctx, config);

  if (existing) {
    return existing;
  }

  console.log(`[pinpoint] Creating app: ${config.name}`);
  const res = await pp.send(new CreateAppCommand({
    CreateApplicationRequest: { Name: config.name },
  }));
  const appId = res.ApplicationResponse?.Id;
  if (!appId) throw new Error(`[pinpoint] CreateApp returned no Id for ${config.name}`);

  console.log(`[pinpoint] Created: ${appId}`);
  return { appId, name: config.name };
}

export async function destroyPinpoint(): Promise<never> {
  throw new Error(
    'forge refuses to destroy Pinpoint apps. Endpoints, segments, and analytics history are irreversible.\n' +
    'Pinpoint is also being discontinued by AWS on 2026-10-30 (push/SMS/voice survive under End User Messaging),\n' +
    'so manual cleanup via Console is the right path.'
  );
}
