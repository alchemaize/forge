/**
 * Pinpoint (mobile push, analytics) resource module.
 *
 * Adoption-focused: looks up Pinpoint apps by name and tracks their AppId
 * so Lambda env vars referencing PINPOINT_APP_ID can be wired up. Creates
 * a new app when one isn't found.
 *
 * Out of scope (manage via AWS Console):
 *   - APNS / GCM credentials (involve P12 certs and signing keys that
 *     don't belong in IaC config)
 *   - SMS sender IDs (per-country regulatory approval)
 *   - Campaigns, journeys, segments (an analytics-side concern that
 *     evolves faster than declarative config can keep up with)
 *
 * Heads up: AWS announced Pinpoint end of support for 2026-10-30.
 * Push / SMS / voice / OTP / phone-validation surfaces survive under
 * "AWS End User Messaging" with a different SDK; engagement features
 * (campaigns, journeys, analytics) move to Amazon Connect Outbound.
 * If you're starting a new mobile project, prefer End User Messaging
 * directly. Forge's renew-app uses Pinpoint for push notifications and
 * will need a migration before the cutoff.
 *
 * SAFETY: Compute-tier — destroy refused. Endpoints + segments +
 * analytics history are irreversible.
 */

import {
  PinpointClient,
  GetAppsCommand,
  CreateAppCommand,
} from '@aws-sdk/client-pinpoint';
import type { AwsContext } from '../aws.js';
import type { PinpointAppConfig } from '../config.js';
import { getClient, ForgeRefusedError } from '../aws.js';
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
  throw new ForgeRefusedError(
    'forge refuses to destroy Pinpoint apps. Endpoints, segments, and analytics history are irreversible.\n' +
    'Pinpoint is also being discontinued by AWS on 2026-10-30 (push/SMS/voice survive under End User Messaging),\n' +
    'so manual cleanup via Console is the right path.'
  );
}
