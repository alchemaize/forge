/**
 * S3 resource module.
 *
 * Creates buckets with encryption, public access blocks, lifecycle rules,
 * CORS, versioning, bucket policies, and tags. Supports {account} and
 * {region} placeholders in bucket names.
 *
 * Drift detection: every settable bucket attribute is compared field-by-field
 * in plan, and apply only PUTs the fields that actually differ. Earlier
 * versions of this module had plan reporting "unchanged" while apply
 * unconditionally re-PUT every attribute on every run, which violated the
 * plan/apply contract. computeS3Drift() is the single source of truth for
 * "what's different"; both plan and apply call it.
 */

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketCorsCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketCorsCommand,
  GetBucketVersioningCommand,
  GetBucketTaggingCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import type { AwsContext } from '../aws.js';
import type { S3BucketConfig } from '../config.js';
import { getClient, resolveTemplate, canonicalize, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface S3BucketState {
  bucketName: string;
  exists: boolean;
}

interface S3DriftField {
  field: string;
  current: any;
  desired: any;
}

interface S3Drift {
  needsEncryption: boolean;
  needsPublicAccessBlock: boolean;
  needsLifecycle: boolean;
  needsCors: boolean;
  needsVersioning: boolean;
  needsPolicy: boolean;
  needsTags: boolean;
  /** True if aws:* system tags exist; we skip the Forge tag PUT entirely. */
  systemTagsBlocking: boolean;
  fields: S3DriftField[];
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeS3Bucket(
  ctx: AwsContext,
  bucketName: string
): Promise<S3BucketState | null> {
  const s3 = getClient(ctx, S3Client);

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return { bucketName, exists: true };
  } catch (err: any) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404 || err.$metadata?.httpStatusCode === 403) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Compare live bucket settings to the desired config and return a diff
 * description. Each `needsX` flag tells apply whether to fire the matching
 * PUT call; `fields` is consumed by plan to render a change preview.
 */
async function computeS3Drift(
  s3: S3Client,
  config: S3BucketConfig,
  bucketName: string,
  appName: string
): Promise<S3Drift> {
  const fields: S3DriftField[] = [];
  const drift: S3Drift = {
    needsEncryption: false,
    needsPublicAccessBlock: false,
    needsLifecycle: false,
    needsCors: false,
    needsVersioning: false,
    needsPolicy: false,
    needsTags: false,
    systemTagsBlocking: false,
    fields,
  };

  // Encryption.
  const desiredEncryption = config.encryption ?? 'AES256';
  const desiredSSE = desiredEncryption === 'aws:kms' ? 'aws:kms' : 'AES256';
  let currentSSE: string | undefined;
  try {
    const enc = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucketName }));
    currentSSE = enc.ServerSideEncryptionConfiguration?.Rules?.[0]
      ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
  } catch (err: any) {
    if (err.name !== 'ServerSideEncryptionConfigurationNotFoundError') throw err;
  }
  if (currentSSE !== desiredSSE) {
    drift.needsEncryption = true;
    fields.push({ field: 'encryption', current: currentSSE ?? 'none', desired: desiredSSE });
  }

  // Public access block. Forge always sets all four to true when blockPublicAccess
  // is on; if the user opts out, leave whatever AWS has alone.
  if (config.blockPublicAccess !== false) {
    let pab: any;
    try {
      const res = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }));
      pab = res.PublicAccessBlockConfiguration;
    } catch (err: any) {
      if (err.name !== 'NoSuchPublicAccessBlockConfiguration') throw err;
    }
    const allBlocked = pab?.BlockPublicAcls && pab?.IgnorePublicAcls
      && pab?.BlockPublicPolicy && pab?.RestrictPublicBuckets;
    if (!allBlocked) {
      drift.needsPublicAccessBlock = true;
      fields.push({ field: 'blockPublicAccess', current: !!allBlocked, desired: true });
    }
  }

  // Lifecycle rules. Compare only the user-relevant fields (prefix +
  // expiration days per rule). AWS's response shape includes many fields
  // we don't manage (transitions, noncurrent versions, etc.) and those
  // shouldn't trigger drift.
  if (config.lifecycle?.length) {
    let currentRules: any[] = [];
    try {
      const res = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
      currentRules = res.Rules ?? [];
    } catch (err: any) {
      if (err.name !== 'NoSuchLifecycleConfiguration') throw err;
    }
    const normalize = (rules: any[]) =>
      rules.map(r => ({
        prefix: r.Filter?.Prefix ?? r.Prefix ?? '',
        expirationDays: r.Expiration?.Days,
        status: r.Status ?? 'Enabled',
      })).sort((a, b) => `${a.prefix}|${a.expirationDays}`.localeCompare(`${b.prefix}|${b.expirationDays}`));
    const currentNorm = normalize(currentRules);
    const desiredNorm = normalize(config.lifecycle.map(lc => ({
      Filter: lc.prefix ? { Prefix: lc.prefix } : {},
      Expiration: { Days: lc.expirationDays },
      Status: 'Enabled',
    })));
    if (canonicalize(currentNorm) !== canonicalize(desiredNorm)) {
      drift.needsLifecycle = true;
      fields.push({
        field: 'lifecycle',
        current: `${currentRules.length} rule(s)`,
        desired: `${config.lifecycle.length} rule(s) (config)`,
      });
    }
  }

  // CORS. Same approach: compare only the user-relevant fields.
  if (config.cors) {
    let currentCors: any[] = [];
    try {
      const res = await s3.send(new GetBucketCorsCommand({ Bucket: bucketName }));
      currentCors = res.CORSRules ?? [];
    } catch (err: any) {
      if (err.name !== 'NoSuchCORSConfiguration') throw err;
    }
    const normalize = (rules: any[]) =>
      rules.map(r => ({
        origins: (r.AllowedOrigins ?? []).slice().sort(),
        methods: (r.AllowedMethods ?? []).slice().sort(),
        headers: (r.AllowedHeaders ?? []).slice().sort(),
      }));
    const currentNorm = normalize(currentCors);
    const desiredNorm = normalize([{
      AllowedOrigins: config.cors.origins,
      AllowedMethods: config.cors.methods,
      AllowedHeaders: config.cors.headers ?? ['*'],
    }]);
    if (canonicalize(currentNorm) !== canonicalize(desiredNorm)) {
      drift.needsCors = true;
      fields.push({
        field: 'cors',
        current: currentCors.length ? `${currentCors.length} rule(s)` : 'none',
        desired: 'configured',
      });
    }
  }

  // Versioning.
  if (config.versioning) {
    const res = await s3.send(new GetBucketVersioningCommand({ Bucket: bucketName }));
    if (res.Status !== 'Enabled') {
      drift.needsVersioning = true;
      fields.push({ field: 'versioning', current: res.Status ?? 'disabled', desired: 'Enabled' });
    }
  }

  // Bucket policy. Compare parsed JSON so whitespace and key-order don't
  // produce false positives.
  if (config.policy) {
    let currentPolicy: any = null;
    try {
      const polRes = await s3.send(new GetBucketPolicyCommand({ Bucket: bucketName }));
      if (polRes.Policy) currentPolicy = JSON.parse(polRes.Policy);
    } catch (err: any) {
      if (err.name !== 'NoSuchBucketPolicy') throw err;
    }
    if (canonicalize(currentPolicy) !== canonicalize(config.policy)) {
      drift.needsPolicy = true;
      fields.push({
        field: 'bucketPolicy',
        current: currentPolicy ? 'present, differs' : 'none',
        desired: 'configured',
      });
    }
  }

  // Tags. Adoption-tricky:
  //   - PutBucketTagging is full REPLACE, not merge.
  //   - System tags (aws:cloudformation:*) can't be removed by us, and we
  //     can't re-PUT them either (aws:* is a reserved prefix).
  // So if any aws:* tag exists, skip the Forge tag PUT entirely.
  let existingTags: { Key?: string; Value?: string }[] = [];
  try {
    const tagRes = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    existingTags = tagRes.TagSet ?? [];
    drift.systemTagsBlocking = existingTags.some(t => (t.Key ?? '').startsWith('aws:'));
  } catch (err: any) {
    if (err.name !== 'NoSuchTagSet') throw err;
  }
  if (!drift.systemTagsBlocking) {
    const desiredTags = [
      { Key: 'app', Value: appName },
      { Key: 'managed-by', Value: 'forge' },
    ];
    const currentMap = new Map(existingTags.map(t => [t.Key, t.Value]));
    const tagsMatch = desiredTags.every(t => currentMap.get(t.Key) === t.Value);
    if (!tagsMatch) {
      drift.needsTags = true;
      fields.push({ field: 'tags', current: `${existingTags.length} tag(s)`, desired: 'app + managed-by' });
    }
  }

  return drift;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planS3Bucket(
  ctx: AwsContext,
  config: S3BucketConfig,
  appName: string,
  plan: Plan
): Promise<S3BucketState | null> {
  const s3 = getClient(ctx, S3Client);
  const bucketName = resolveTemplate(config.name, ctx, appName);
  const current = await describeS3Bucket(ctx, bucketName);

  if (!current) {
    addChange(plan, {
      resourceType: 's3',
      resourceId: bucketName,
      changeType: 'create',
      tier: 'data',
      fields: [
        { field: 'encryption', current: undefined, desired: config.encryption ?? 'AES256' },
        { field: 'blockPublicAccess', current: undefined, desired: config.blockPublicAccess ?? true },
        ...(config.lifecycle ?? []).map(lc => ({
          field: `lifecycle:${lc.prefix ?? '*'}`,
          current: undefined,
          desired: `expire after ${lc.expirationDays} days`,
        })),
      ],
    });
    return null;
  }

  // Bucket exists. Detect attribute drift.
  const drift = await computeS3Drift(s3, config, bucketName, appName);
  if (drift.fields.length === 0) {
    addChange(plan, {
      resourceType: 's3',
      resourceId: bucketName,
      changeType: 'unchanged',
      tier: 'data',
      fields: [],
    });
  } else {
    addChange(plan, {
      resourceType: 's3',
      resourceId: bucketName,
      changeType: 'update',
      tier: 'data',
      fields: drift.fields,
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyS3Bucket(
  ctx: AwsContext,
  config: S3BucketConfig,
  appName: string
): Promise<S3BucketState> {
  const s3 = getClient(ctx, S3Client);
  const bucketName = resolveTemplate(config.name, ctx, appName);
  const current = await describeS3Bucket(ctx, bucketName);

  if (!current) {
    console.log(`[s3] Creating bucket: ${bucketName}`);

    const createParams: any = { Bucket: bucketName };
    // us-east-1 doesn't need LocationConstraint
    if (ctx.region !== 'us-east-1') {
      createParams.CreateBucketConfiguration = { LocationConstraint: ctx.region };
    }
    await s3.send(new CreateBucketCommand(createParams));
    console.log(`[s3] Created: ${bucketName}`);
    // For freshly created buckets, every desired setting is drift. Fall
    // through to the apply branch below with a synthetic "all drifted"
    // result so the same code path PUTs everything.
    return await applyS3DriftedFields(s3, config, bucketName, appName, {
      needsEncryption: true,
      needsPublicAccessBlock: config.blockPublicAccess !== false,
      needsLifecycle: !!config.lifecycle?.length,
      needsCors: !!config.cors,
      needsVersioning: !!config.versioning,
      needsPolicy: !!config.policy,
      needsTags: true,
      systemTagsBlocking: false,
      fields: [],
    });
  }

  console.log(`[s3] Bucket exists: ${bucketName}`);
  const drift = await computeS3Drift(s3, config, bucketName, appName);
  if (drift.fields.length === 0) {
    console.log(`[s3] ${bucketName}: no changes needed`);
    return { bucketName, exists: true };
  }
  return await applyS3DriftedFields(s3, config, bucketName, appName, drift);
}

/**
 * Apply only the fields that drift. Each PUT is idempotent and gated on
 * the corresponding `needsX` flag. Greenfield apply marks everything
 * drifted; existing-bucket apply sees only what changed.
 */
async function applyS3DriftedFields(
  s3: S3Client,
  config: S3BucketConfig,
  bucketName: string,
  appName: string,
  drift: S3Drift
): Promise<S3BucketState> {
  const encryption = config.encryption ?? 'AES256';

  if (drift.needsEncryption) {
    console.log(`[s3] ${bucketName}: setting encryption (${encryption})`);
    await s3.send(new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [{
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: encryption === 'aws:kms' ? 'aws:kms' : 'AES256',
          },
          BucketKeyEnabled: true,
        }],
      },
    }));
  }

  if (drift.needsPublicAccessBlock) {
    console.log(`[s3] ${bucketName}: setting public access block`);
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }));
  }

  if (drift.needsLifecycle && config.lifecycle?.length) {
    console.log(`[s3] ${bucketName}: setting lifecycle (${config.lifecycle.length} rule${config.lifecycle.length > 1 ? 's' : ''})`);
    await s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: {
        Rules: config.lifecycle.map((lc, i) => ({
          ID: `forge-lifecycle-${i}`,
          Status: 'Enabled',
          ...(lc.prefix ? { Filter: { Prefix: lc.prefix } } : { Filter: {} }),
          Expiration: { Days: lc.expirationDays },
        })),
      },
    }));
  }

  if (drift.needsCors && config.cors) {
    console.log(`[s3] ${bucketName}: setting CORS`);
    await s3.send(new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [{
          AllowedOrigins: config.cors.origins,
          AllowedMethods: config.cors.methods,
          AllowedHeaders: config.cors.headers ?? ['*'],
          MaxAgeSeconds: 3600,
        }],
      },
    }));
  }

  if (drift.needsVersioning && config.versioning) {
    console.log(`[s3] ${bucketName}: enabling versioning`);
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: 'Enabled' },
    }));
  }

  if (drift.needsPolicy && config.policy) {
    console.log(`[s3] ${bucketName}: updating bucket policy`);
    await s3.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(config.policy),
    }));
  }

  if (drift.needsTags && !drift.systemTagsBlocking) {
    console.log(`[s3] ${bucketName}: setting tags`);
    await s3.send(new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      },
    }));
  } else if (drift.systemTagsBlocking) {
    console.log(`[s3] ${bucketName}: has aws:* system tags, skipping Forge tag PUT`);
  }

  return { bucketName, exists: true };
}

export async function destroyS3Bucket(
  ctx: AwsContext,
  bucketName: string,
  confirmDataLoss: boolean
): Promise<void> {
  if (!confirmDataLoss) {
    throw new ForgeRefusedError(
      `forge refuses to destroy S3 bucket '${bucketName}' without --confirm-data-loss flag.\n` +
      'This is a data-tier resource. Deletion is irreversible.'
    );
  }

  const s3 = getClient(ctx, S3Client);
  const { DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');

  // Empty bucket first
  let continuationToken: string | undefined;
  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    }));
    if (listRes.Contents?.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: listRes.Contents.map(o => ({ Key: o.Key! })) },
      }));
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
  console.log(`[s3] Deleted: ${bucketName}`);
}
