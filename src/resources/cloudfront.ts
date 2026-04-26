/**
 * CloudFront resource module.
 *
 * Manages CloudFront distributions. Supports S3 origins (with OAC)
 * and custom origins (ALB, ECS Express, API Gateway).
 *
 * SAFETY: Distributions are compute-tier — normal destroy.
 */

import {
  CloudFrontClient,
  ListDistributionsCommand,
  GetDistributionCommand,
  CreateDistributionCommand,
  UpdateDistributionCommand,
  type DistributionSummary,
} from '@aws-sdk/client-cloudfront';
import type { AwsContext } from '../aws.js';
import type { CloudFrontDistributionConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface CloudFrontState {
  distributionId: string;
  domainName: string;
  status: string;
  aliases: string[];
  originDomain: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeCloudFront(
  ctx: AwsContext,
  config: CloudFrontDistributionConfig,
  appName: string
): Promise<CloudFrontState | null> {
  const cf = getClient(ctx, CloudFrontClient);

  // Find distribution by matching origin domain or alias
  const listRes = await cf.send(new ListDistributionsCommand({ MaxItems: '100' }));
  const distributions = listRes.DistributionList?.Items ?? [];

  let match: DistributionSummary | undefined;

  // Match by S3 origin bucket name
  if (config.s3Origin) {
    const bucketDomain = `${config.s3Origin}.s3.${ctx.region}.amazonaws.com`;
    match = distributions.find(d =>
      d.Origins?.Items?.some(o =>
        o.DomainName?.includes(config.s3Origin!) ||
        o.DomainName === bucketDomain
      )
    );
  }

  // Match by custom origin
  if (!match && config.customOrigin) {
    match = distributions.find(d =>
      d.Origins?.Items?.some(o => o.DomainName === config.customOrigin)
    );
  }

  // Match by alias
  if (!match && config.aliases?.length) {
    match = distributions.find(d =>
      config.aliases!.some(alias =>
        d.Aliases?.Items?.includes(alias)
      )
    );
  }

  if (!match) return null;

  return {
    distributionId: match.Id!,
    domainName: match.DomainName!,
    status: match.Status!,
    aliases: match.Aliases?.Items ?? [],
    originDomain: match.Origins?.Items?.[0]?.DomainName ?? '',
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planCloudFront(
  ctx: AwsContext,
  config: CloudFrontDistributionConfig,
  appName: string,
  plan: Plan
): Promise<CloudFrontState | null> {
  const current = await describeCloudFront(ctx, config, appName);

  if (current) {
    addChange(plan, {
      resourceType: 'cloudfront',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'cloudfront',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'origin', current: undefined, desired: config.s3Origin ?? config.customOrigin },
      { field: 'defaultRootObject', current: undefined, desired: config.defaultRootObject ?? 'index.html' },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply — placeholder (read-only adoption for now)
// ---------------------------------------------------------------------------

export async function applyCloudFront(
  ctx: AwsContext,
  config: CloudFrontDistributionConfig,
  appName: string
): Promise<CloudFrontState | null> {
  const existing = await describeCloudFront(ctx, config, appName);
  if (existing) {
    console.log(`[cloudfront] ${config.name} — ${existing.domainName} (${existing.status})`);
    return existing;
  }

  // TODO: Create distribution
  console.log(`[cloudfront] ${config.name} — not found. Create via AWS Console or extend this module.`);
  return null;
}
