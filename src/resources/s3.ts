/**
 * S3 resource module.
 *
 * Creates buckets with encryption, public access blocks, lifecycle rules.
 * Supports {account} and {region} placeholders in bucket names.
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
} from '@aws-sdk/client-s3';
import type { AwsContext } from '../aws.js';
import type { S3BucketConfig } from '../config.js';
import { getClient, resolveTemplate } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface S3BucketState {
  bucketName: string;
  exists: boolean;
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
// Plan
// ---------------------------------------------------------------------------

export async function planS3Bucket(
  ctx: AwsContext,
  config: S3BucketConfig,
  appName: string,
  plan: Plan
): Promise<S3BucketState | null> {
  const bucketName = resolveTemplate(config.name, ctx, appName);
  const current = await describeS3Bucket(ctx, bucketName);

  if (current) {
    addChange(plan, {
      resourceType: 's3',
      resourceId: bucketName,
      changeType: 'unchanged',
      tier: 'data',
      fields: [],
    });
    return current;
  }

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
  } else {
    console.log(`[s3] Bucket exists: ${bucketName}`);
  }

  // Encryption
  const encryption = config.encryption ?? 'AES256';
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

  // Public access block
  if (config.blockPublicAccess !== false) {
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

  // Lifecycle rules
  if (config.lifecycle?.length) {
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

  // CORS
  if (config.cors) {
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

  // Versioning
  if (config.versioning) {
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: 'Enabled' },
    }));
  }

  // Tags
  await s3.send(new PutBucketTaggingCommand({
    Bucket: bucketName,
    Tagging: {
      TagSet: [
        { Key: 'app', Value: appName },
        { Key: 'managed-by', Value: 'forge' },
      ],
    },
  }));

  return { bucketName, exists: true };
}

export async function destroyS3Bucket(
  ctx: AwsContext,
  bucketName: string,
  confirmDataLoss: boolean
): Promise<void> {
  if (!confirmDataLoss) {
    throw new Error(
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
