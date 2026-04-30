/**
 * OpenSearch domain resource module.
 *
 * Manages OpenSearch (formerly Elasticsearch) domains. Common use cases:
 *   - Search backends for SaaS products
 *   - Vector search for Bedrock RAG (knowledge bases)
 *   - Log aggregation alongside CloudWatch
 *
 * Adoption-safe: existing domains adopt by name. Most attribute changes
 * (instance type, count, encryption) trigger AWS-side blue/green deploys
 * which take 30+ minutes; Forge proposes them but doesn't wait for
 * completion (re-run plan to confirm).
 *
 * SAFETY: Data-tier — destroy refused (the index data is gone for good).
 *
 * NOTE: This module manages classic OpenSearch domains. OpenSearch
 * Serverless uses a different SDK (opensearchserverless) and isn't
 * covered here — request explicitly if needed.
 */

import {
  OpenSearchClient,
  DescribeDomainCommand,
  CreateDomainCommand,
  UpdateDomainConfigCommand,
} from '@aws-sdk/client-opensearch';
import type { AwsContext } from '../aws.js';
import type { OpenSearchDomainConfig } from '../config.js';
import { getClient, withContext, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface OpenSearchDomainState {
  domainName: string;
  arn: string;
  endpoint?: string;
  engineVersion: string;
  instanceType: string;
  instanceCount: number;
  encryptAtRest: boolean;
  nodeToNodeEncryption: boolean;
  processing: boolean;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeOpenSearchDomain(
  ctx: AwsContext,
  config: OpenSearchDomainConfig
): Promise<OpenSearchDomainState | null> {
  const os: OpenSearchClient = getClient(ctx, OpenSearchClient);
  try {
    const res = await os.send(new DescribeDomainCommand({ DomainName: config.name }));
    const status = res.DomainStatus;
    if (!status) return null;
    return {
      domainName: status.DomainName!,
      arn: status.ARN!,
      endpoint: status.Endpoint,
      engineVersion: status.EngineVersion ?? '',
      instanceType: status.ClusterConfig?.InstanceType ?? '',
      instanceCount: status.ClusterConfig?.InstanceCount ?? 0,
      encryptAtRest: status.EncryptionAtRestOptions?.Enabled ?? false,
      nodeToNodeEncryption: status.NodeToNodeEncryptionOptions?.Enabled ?? false,
      processing: status.Processing ?? false,
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planOpenSearchDomain(
  ctx: AwsContext,
  config: OpenSearchDomainConfig,
  _appName: string,
  plan: Plan
): Promise<OpenSearchDomainState | null> {
  const current = await describeOpenSearchDomain(ctx, config);
  const desiredVersion = config.engineVersion ?? 'OpenSearch_2.13';
  const desiredType = config.clusterConfig?.instanceType ?? 't3.small.search';
  const desiredCount = config.clusterConfig?.instanceCount ?? 1;

  if (!current) {
    addChange(plan, {
      resourceType: 'opensearch-domain',
      resourceId: config.name,
      changeType: 'create',
      tier: 'data',
      fields: [
        { field: 'engineVersion', current: undefined, desired: desiredVersion },
        { field: 'instance', current: undefined, desired: `${desiredCount}× ${desiredType}` },
        { field: 'encryptAtRest', current: undefined, desired: config.encryptAtRest ?? true },
      ],
    });
    return null;
  }

  if (current.processing) {
    addChange(plan, {
      resourceType: 'opensearch-domain',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'data',
      fields: [{ field: 'status', current: 'processing change', desired: '(wait)' }],
    });
    return current;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.engineVersion !== desiredVersion && config.engineVersion) {
    fields.push({ field: 'engineVersion', current: current.engineVersion, desired: desiredVersion });
  }
  if (current.instanceType !== desiredType && config.clusterConfig?.instanceType) {
    fields.push({ field: 'instanceType', current: current.instanceType, desired: desiredType });
  }
  if (current.instanceCount !== desiredCount && config.clusterConfig?.instanceCount !== undefined) {
    fields.push({ field: 'instanceCount', current: current.instanceCount, desired: desiredCount });
  }
  addChange(plan, {
    resourceType: 'opensearch-domain',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'data',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyOpenSearchDomain(
  ctx: AwsContext,
  config: OpenSearchDomainConfig,
  _appName: string
): Promise<OpenSearchDomainState> {
  const os: OpenSearchClient = getClient(ctx, OpenSearchClient);
  let current = await describeOpenSearchDomain(ctx, config);

  const clusterConfig = {
    InstanceType: config.clusterConfig?.instanceType ?? 't3.small.search',
    InstanceCount: config.clusterConfig?.instanceCount ?? 1,
    DedicatedMasterEnabled: config.clusterConfig?.dedicatedMasterEnabled ?? false,
    DedicatedMasterType: config.clusterConfig?.masterInstanceType,
    DedicatedMasterCount: config.clusterConfig?.masterInstanceCount,
    ZoneAwarenessEnabled: config.clusterConfig?.zoneAwarenessEnabled ?? false,
  };

  if (!current) {
    console.log(`[opensearch] Creating domain: ${config.name} (${clusterConfig.InstanceCount}× ${clusterConfig.InstanceType})`);
    try {
      await os.send(new CreateDomainCommand({
        DomainName: config.name,
        EngineVersion: config.engineVersion ?? 'OpenSearch_2.13',
        ClusterConfig: clusterConfig as any,
        EBSOptions: config.ebs
          ? {
              EBSEnabled: true,
              VolumeType: (config.ebs.volumeType ?? 'gp3') as any,
              VolumeSize: config.ebs.volumeSize ?? 20,
            }
          : { EBSEnabled: true, VolumeType: 'gp3', VolumeSize: 20 },
        EncryptionAtRestOptions: { Enabled: config.encryptAtRest ?? true },
        NodeToNodeEncryptionOptions: { Enabled: config.nodeToNodeEncryption ?? true },
        DomainEndpointOptions: { EnforceHTTPS: true },
        AccessPolicies: config.accessPolicy ? JSON.stringify(config.accessPolicy) : undefined,
        VPCOptions: config.subnetIds?.length
          ? {
              SubnetIds: config.subnetIds,
              SecurityGroupIds: config.securityGroupIds,
            }
          : undefined,
      }));
      console.log(`[opensearch] Created. Provisioning typically takes ~15 minutes.`);
    } catch (err) {
      throw withContext(`[opensearch] CreateDomain ${config.name}`, err);
    }
    return (await describeOpenSearchDomain(ctx, config))!;
  }

  if (current.processing) {
    console.log(`[opensearch] ${config.name} is currently processing a previous change; skipping update.`);
    return current;
  }

  // Detect actionable drift; UpdateDomainConfig accepts only the fields
  // that need to change. Skip when nothing's drifted to avoid AWS
  // rejecting empty modifications.
  const updates: any = {};
  if (config.clusterConfig?.instanceType && current.instanceType !== config.clusterConfig.instanceType) {
    updates.ClusterConfig = clusterConfig;
  }
  if (config.clusterConfig?.instanceCount !== undefined && current.instanceCount !== config.clusterConfig.instanceCount) {
    updates.ClusterConfig = clusterConfig;
  }
  if (Object.keys(updates).length > 0) {
    console.log(`[opensearch] Updating: ${config.name} (blue/green deploy may take 30+ minutes)`);
    try {
      await os.send(new UpdateDomainConfigCommand({
        DomainName: config.name,
        ...updates,
      }));
    } catch (err) {
      throw withContext(`[opensearch] UpdateDomainConfig ${config.name}`, err);
    }
  }
  return (await describeOpenSearchDomain(ctx, config))!;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyOpenSearchDomain(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy OpenSearch domains. The index data is gone\n' +
    'permanently and clients break immediately. Snapshot the indices to S3,\n' +
    'verify the snapshot, then DeleteDomain via AWS Console.'
  );
}
