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
import { getClient, ForgeRefusedError } from '../aws.js';
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
  const listRes = await cf.send(new ListDistributionsCommand({ MaxItems: 100 }));
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
// Apply
// ---------------------------------------------------------------------------

/**
 * Build a minimal viable CloudFront DistributionConfig for create.
 * Covers the common SPA + CDN use cases (txdmv-rts: 4 SPA portals, S3 origin, OAI).
 *
 * NOT covered (defer to manual / Console for now):
 *   - WAF Web ACL attachment (config.webAclArn captured, not applied here)
 *   - Multiple cache behaviors (single default behavior only)
 *   - Lambda@Edge / CloudFront Functions
 *   - Custom certificates (uses CloudFront default cert; aliases need ACM)
 *   - Custom origins beyond a single domain
 */
function buildDistributionConfig(
  config: CloudFrontDistributionConfig,
  ctx: AwsContext,
  callerReference: string
): any {
  const originDomain = config.s3Origin
    ? `${config.s3Origin}.s3.${ctx.region}.amazonaws.com`
    : config.customOrigin;
  if (!originDomain) {
    throw new Error(`[cloudfront] ${config.name}: must specify s3Origin or customOrigin`);
  }

  const isS3 = !!config.s3Origin;
  const originId = isS3 ? `s3-${config.s3Origin}` : `custom-${config.customOrigin?.replace(/[^a-zA-Z0-9]/g, '-')}`;

  const customErrors = config.spaErrorResponses ? {
    Quantity: 2,
    Items: [
      { ErrorCode: 403, ResponsePagePath: `/${config.defaultRootObject ?? 'index.html'}`, ResponseCode: '200', ErrorCachingMinTTL: 0 },
      { ErrorCode: 404, ResponsePagePath: `/${config.defaultRootObject ?? 'index.html'}`, ResponseCode: '200', ErrorCachingMinTTL: 0 },
    ],
  } : { Quantity: 0, Items: [] };

  const aliases = config.aliases?.length
    ? { Quantity: config.aliases.length, Items: config.aliases }
    : { Quantity: 0, Items: [] };

  return {
    CallerReference: callerReference,
    Comment: `forge-managed: ${config.name}`,
    Enabled: true,
    DefaultRootObject: config.defaultRootObject ?? 'index.html',
    Aliases: aliases,
    Origins: {
      Quantity: 1,
      Items: [
        isS3
          ? {
              Id: originId,
              DomainName: originDomain,
              S3OriginConfig: { OriginAccessIdentity: '' },
              CustomHeaders: { Quantity: 0 },
              OriginPath: '',
            }
          : {
              Id: originId,
              DomainName: originDomain,
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: 'https-only',
                OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
                OriginReadTimeout: 30,
                OriginKeepaliveTimeout: 5,
              },
              CustomHeaders: { Quantity: 0 },
              OriginPath: '',
            },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: originId,
      ViewerProtocolPolicy: config.viewerProtocolPolicy ?? 'redirect-to-https',
      AllowedMethods: {
        Quantity: 2,
        Items: ['GET', 'HEAD'],
        CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
      },
      Compress: true,
      // Use AWS-managed CachingOptimized policy (recommended for SPAs).
      CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
      OriginRequestPolicyId: undefined,
      ResponseHeadersPolicyId: undefined,
    },
    CacheBehaviors: { Quantity: 0 },
    CustomErrorResponses: customErrors,
    ViewerCertificate: config.certificateArn ? {
      ACMCertificateArn: config.certificateArn,
      SSLSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    } : {
      CloudFrontDefaultCertificate: true,
      MinimumProtocolVersion: 'TLSv1',
    },
    PriceClass: config.priceClass ?? 'PriceClass_100',
    HttpVersion: 'http2',
    IsIPV6Enabled: true,
    Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0 } },
    WebACLId: config.webAclArn ?? '',
  };
}

export async function applyCloudFront(
  ctx: AwsContext,
  config: CloudFrontDistributionConfig,
  _appName: string
): Promise<CloudFrontState> {
  const cf: CloudFrontClient = getClient(ctx, CloudFrontClient);
  const existing = await describeCloudFront(ctx, config, _appName);

  if (existing) {
    console.log(`[cloudfront] ${config.name} — ${existing.domainName} (${existing.status})`);
    // Drift detection on existing distros is intentionally minimal — DistributionConfig
    // is huge and most fields are managed via Console for SPAs. Adoption is the
    // primary use case here. For genuine reconfiguration, do it via Console + re-import.
    return existing;
  }

  console.log(`[cloudfront] Creating distribution: ${config.name}`);
  // CallerReference must be unique per CreateDistribution call. Use a timestamp +
  // config name so retries within the same minute don't collide silently.
  const callerRef = `forge-${config.name}-${Date.now()}`;
  const distConfig = buildDistributionConfig(config, ctx, callerRef);

  const createRes = await cf.send(new CreateDistributionCommand({
    DistributionConfig: distConfig,
  }));
  const dist = createRes.Distribution;
  if (!dist) throw new Error(`[cloudfront] CreateDistribution returned no Distribution object`);

  console.log(`[cloudfront] Created: ${dist.Id} (${dist.DomainName}) — propagating, status: ${dist.Status}`);
  // Don't wait for InProgress → Deployed; that takes 10-15 minutes. The distribution
  // is usable for further config (origin permissions, etc.) immediately even though
  // it's still propagating to edges.

  return {
    distributionId: dist.Id!,
    domainName: dist.DomainName!,
    status: dist.Status!,
    aliases: dist.DistributionConfig?.Aliases?.Items ?? [],
    originDomain: dist.DistributionConfig?.Origins?.Items?.[0]?.DomainName ?? '',
  };
}

export async function destroyCloudFront(_ctx: AwsContext, name: string): Promise<never> {
  throw new ForgeRefusedError(
    `forge refuses to destroy CloudFront distribution '${name}' automatically.\n` +
    'Distributions take 10-15 minutes to disable, then 10-15 minutes to delete,\n' +
    'and breaking the wrong one takes a public site offline. Disable the\n' +
    'distribution via the AWS Console, wait for "Deployed" status, then delete.'
  );
}

// Suppress unused-import warnings for symbols reserved for future use.
void GetDistributionCommand;
void UpdateDistributionCommand;
