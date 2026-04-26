/**
 * ElastiCache (Redis/Valkey) resource module.
 *
 * Manages ElastiCache replication groups. Uses CfnReplicationGroup
 * (not CfnCacheCluster) because only replication groups support
 * transit encryption, at-rest encryption, and auth tokens.
 *
 * SAFETY: Data-tier — forge destroy REFUSES.
 */

import {
  ElastiCacheClient,
  DescribeReplicationGroupsCommand,
  DescribeCacheClustersCommand,
} from '@aws-sdk/client-elasticache';
import type { AwsContext } from '../aws.js';
import type { ElastiCacheConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface ElastiCacheState {
  replicationGroupId: string;
  primaryEndpoint: string;
  port: number;
  status: string;
  nodeType: string;
  transitEncryption: boolean;
  atRestEncryption: boolean;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeElastiCache(
  ctx: AwsContext,
  config: ElastiCacheConfig,
  appName: string
): Promise<ElastiCacheState | null> {
  const ec = getClient(ctx, ElastiCacheClient);

  // Try replication group by explicit ID override, then by name, then by app-prefixed name
  const groupId = config.replicationGroupId ?? config.name;
  try {
    const res = await ec.send(new DescribeReplicationGroupsCommand({
      ReplicationGroupId: groupId,
    }));
    const group = res.ReplicationGroups?.[0];
    if (group) {
      return {
        replicationGroupId: group.ReplicationGroupId!,
        primaryEndpoint: group.NodeGroups?.[0]?.PrimaryEndpoint?.Address ?? '',
        port: group.NodeGroups?.[0]?.PrimaryEndpoint?.Port ?? 6379,
        status: group.Status ?? 'unknown',
        nodeType: group.CacheNodeType ?? config.nodeType ?? 'cache.t3.micro',
        transitEncryption: group.TransitEncryptionEnabled ?? false,
        atRestEncryption: group.AtRestEncryptionEnabled ?? false,
      };
    }
  } catch (err: any) {
    if (err.name !== 'ReplicationGroupNotFoundFault') {
      // Try with app-prefixed name
      try {
        const res2 = await ec.send(new DescribeReplicationGroupsCommand({
          ReplicationGroupId: `${appName}-redis`,
        }));
        const group2 = res2.ReplicationGroups?.[0];
        if (group2) {
          return {
            replicationGroupId: group2.ReplicationGroupId!,
            primaryEndpoint: group2.NodeGroups?.[0]?.PrimaryEndpoint?.Address ?? '',
            port: group2.NodeGroups?.[0]?.PrimaryEndpoint?.Port ?? 6379,
            status: group2.Status ?? 'unknown',
            nodeType: group2.CacheNodeType ?? config.nodeType ?? 'cache.t3.micro',
            transitEncryption: group2.TransitEncryptionEnabled ?? false,
            atRestEncryption: group2.AtRestEncryptionEnabled ?? false,
          };
        }
      } catch {
        // Not found
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planElastiCache(
  ctx: AwsContext,
  config: ElastiCacheConfig,
  appName: string,
  plan: Plan
): Promise<ElastiCacheState | null> {
  const current = await describeElastiCache(ctx, config, appName);

  if (current) {
    addChange(plan, {
      resourceType: 'elasticache',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'data',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'elasticache',
    resourceId: config.name,
    changeType: 'create',
    tier: 'data',
    fields: [
      { field: 'engine', current: undefined, desired: config.engine ?? 'redis' },
      { field: 'nodeType', current: undefined, desired: config.nodeType ?? 'cache.t3.micro' },
      { field: 'transitEncryption', current: undefined, desired: config.transitEncryption ?? true },
      { field: 'atRestEncryption', current: undefined, desired: config.atRestEncryption ?? true },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply — placeholder (read-only adoption for now)
// ---------------------------------------------------------------------------

export async function applyElastiCache(
  ctx: AwsContext,
  config: ElastiCacheConfig,
  appName: string
): Promise<ElastiCacheState | null> {
  const existing = await describeElastiCache(ctx, config, appName);
  if (existing) {
    console.log(`[elasticache] ${config.name} — ${existing.primaryEndpoint}:${existing.port} (${existing.status})`);
    return existing;
  }

  // TODO: Create replication group
  console.log(`[elasticache] ${config.name} — not found. Create via AWS Console or extend this module.`);
  return null;
}

/**
 * Destroy — REFUSED for data-tier resources.
 */
export async function destroyElastiCache(): Promise<never> {
  throw new Error(
    'forge refuses to destroy ElastiCache resources. Data loss is irreversible.\n' +
    'To delete a Redis replication group, use the AWS Console or CLI manually.'
  );
}
