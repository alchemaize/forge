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
    // Adoption-only today: forge reads but doesn't reconcile attributes
    // beyond existence. Report unchanged truthfully — apply does the same.
    addChange(plan, {
      resourceType: 'elasticache',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'data',
      fields: [],
    });
    return current;
  }

  // Not found, and create is not implemented. Be honest in plan: this
  // would error on apply, so flag it loudly. Avoids the earlier
  // plan-lies-apply-noops pattern.
  addChange(plan, {
    resourceType: 'elasticache',
    resourceId: config.name,
    changeType: 'create',
    tier: 'data',
    fields: [
      { field: '!! CREATE NOT IMPLEMENTED', current: undefined, desired: 'manual provision required' },
      { field: 'engine', current: undefined, desired: config.engine ?? 'redis' },
      { field: 'nodeType', current: undefined, desired: config.nodeType ?? 'cache.t3.micro' },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
//
// Adoption-only today. Create is intentionally not implemented because no
// project in the dev workspace creates ElastiCache via Forge (existing
// clusters were all provisioned by CDK or console and are adopted as-is).
// If you need to create one, do it via Console or AWS CLI, then re-run
// `forge import` so the config matches.
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

  throw new Error(
    `[elasticache] ${config.name}: replication group not found and create is not implemented.\n` +
    `Provision the cluster via AWS Console or CLI, then re-run 'forge import' to capture it.\n` +
    `(Adoption-only today; native create can be added if a real project needs it.)`
  );
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
