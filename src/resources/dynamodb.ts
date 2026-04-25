/**
 * DynamoDB resource module.
 *
 * Creates tables with GSIs, TTL, and PAY_PER_REQUEST billing.
 * Idempotent — skips existing tables, detects drift on TTL and GSIs.
 */

import {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  type ScalarAttributeType,
} from '@aws-sdk/client-dynamodb';
import type { AwsContext } from '../aws.js';
import type { DynamoTableConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface DynamoTableState {
  tableName: string;
  tableArn: string;
  status: string;
  pk: string;
  sk?: string;
  gsiNames: string[];
  ttlAttribute?: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeDynamoTable(
  ctx: AwsContext,
  tableName: string
): Promise<DynamoTableState | null> {
  const ddb = getClient(ctx, DynamoDBClient);

  try {
    const res = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
    const table = res.Table!;

    const pk = table.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName ?? '';
    const sk = table.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName;
    const gsiNames = (table.GlobalSecondaryIndexes ?? []).map(g => g.IndexName!);

    // Get TTL
    let ttlAttribute: string | undefined;
    try {
      const ttlRes = await ddb.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
      if (ttlRes.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED') {
        ttlAttribute = ttlRes.TimeToLiveDescription.AttributeName;
      }
    } catch {
      // TTL describe failed — not critical
    }

    return {
      tableName,
      tableArn: table.TableArn!,
      status: table.TableStatus!,
      pk,
      sk,
      gsiNames,
      ttlAttribute,
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planDynamoTable(
  ctx: AwsContext,
  config: DynamoTableConfig,
  appName: string,
  plan: Plan
): Promise<DynamoTableState | null> {
  const current = await describeDynamoTable(ctx, config.name);

  if (current) {
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

    // Check TTL drift
    if (config.ttl && current.ttlAttribute !== config.ttl) {
      fields.push({ field: 'ttl', current: current.ttlAttribute ?? 'disabled', desired: config.ttl });
    }

    // Check missing GSIs
    const desiredGsis = (config.gsi ?? []).map(g => g.name);
    const missingGsis = desiredGsis.filter(g => !current.gsiNames.includes(g));
    if (missingGsis.length > 0) {
      fields.push({ field: 'gsi', current: current.gsiNames, desired: desiredGsis });
    }

    addChange(plan, {
      resourceType: 'dynamodb',
      resourceId: config.name,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'data',
      fields,
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'dynamodb',
    resourceId: config.name,
    changeType: 'create',
    tier: 'data',
    fields: [
      { field: 'pk', current: undefined, desired: config.pk },
      ...(config.sk ? [{ field: 'sk', current: undefined, desired: config.sk }] : []),
      ...(config.gsi ?? []).map(g => ({ field: `gsi:${g.name}`, current: undefined, desired: `pk=${g.pk}${g.sk ? `, sk=${g.sk}` : ''}` })),
      ...(config.ttl ? [{ field: 'ttl', current: undefined, desired: config.ttl }] : []),
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyDynamoTable(
  ctx: AwsContext,
  config: DynamoTableConfig,
  appName: string
): Promise<DynamoTableState> {
  const ddb = getClient(ctx, DynamoDBClient);
  let current = await describeDynamoTable(ctx, config.name);

  if (!current) {
    // Build attribute definitions
    const attrDefs: Array<{ AttributeName: string; AttributeType: ScalarAttributeType }> = [
      { AttributeName: config.pk, AttributeType: (config.pkType ?? 'S') as ScalarAttributeType },
    ];
    if (config.sk) {
      attrDefs.push({ AttributeName: config.sk, AttributeType: (config.skType ?? 'S') as ScalarAttributeType });
    }

    // Add GSI key attributes
    for (const gsi of config.gsi ?? []) {
      if (!attrDefs.some(a => a.AttributeName === gsi.pk)) {
        attrDefs.push({ AttributeName: gsi.pk, AttributeType: 'S' as ScalarAttributeType });
      }
      if (gsi.sk && !attrDefs.some(a => a.AttributeName === gsi.sk)) {
        attrDefs.push({ AttributeName: gsi.sk, AttributeType: 'S' as ScalarAttributeType });
      }
    }

    const keySchema = [
      { AttributeName: config.pk, KeyType: 'HASH' as const },
      ...(config.sk ? [{ AttributeName: config.sk, KeyType: 'RANGE' as const }] : []),
    ];

    const gsis = (config.gsi ?? []).map(g => ({
      IndexName: g.name,
      KeySchema: [
        { AttributeName: g.pk, KeyType: 'HASH' as const },
        ...(g.sk ? [{ AttributeName: g.sk, KeyType: 'RANGE' as const }] : []),
      ],
      Projection: {
        ProjectionType: (Array.isArray(g.projection) ? 'INCLUDE' : (g.projection ?? 'ALL')) as any,
        ...(Array.isArray(g.projection) ? { NonKeyAttributes: g.projection } : {}),
      },
    }));

    console.log(`[dynamodb] Creating table: ${config.name}`);
    await ddb.send(new CreateTableCommand({
      TableName: config.name,
      AttributeDefinitions: attrDefs,
      KeySchema: keySchema,
      BillingMode: config.billingMode ?? 'PAY_PER_REQUEST',
      ...(gsis.length > 0 ? { GlobalSecondaryIndexes: gsis } : {}),
      Tags: [
        { Key: 'app', Value: appName },
        { Key: 'managed-by', Value: 'forge' },
      ],
    }));

    // Wait for table to be active
    console.log(`[dynamodb] Waiting for ${config.name} to become active...`);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      current = await describeDynamoTable(ctx, config.name);
      if (current?.status === 'ACTIVE') break;
    }

    if (!current || current.status !== 'ACTIVE') {
      throw new Error(`Table ${config.name} did not become active`);
    }
    console.log(`[dynamodb] Created: ${config.name}`);
  } else {
    console.log(`[dynamodb] Table exists: ${config.name}`);
  }

  // Enable TTL if configured
  if (config.ttl && current!.ttlAttribute !== config.ttl) {
    console.log(`[dynamodb] Enabling TTL on ${config.name}: ${config.ttl}`);
    try {
      await ddb.send(new UpdateTimeToLiveCommand({
        TableName: config.name,
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: config.ttl,
        },
      }));
    } catch (err: any) {
      // TTL might already be enabled or in transition
      if (!err.message?.includes('already enabled')) {
        console.log(`[dynamodb] TTL update note: ${err.message}`);
      }
    }
  }

  return current!;
}

export async function destroyDynamoTable(
  ctx: AwsContext,
  tableName: string,
  confirmDataLoss: boolean
): Promise<void> {
  if (!confirmDataLoss) {
    throw new Error(
      `forge refuses to destroy DynamoDB table '${tableName}' without --confirm-data-loss flag.\n` +
      'This is a data-tier resource. Deletion is irreversible.'
    );
  }

  const ddb = getClient(ctx, DynamoDBClient);
  const { DeleteTableCommand } = await import('@aws-sdk/client-dynamodb');
  console.log(`[dynamodb] Deleting table: ${tableName}`);
  await ddb.send(new DeleteTableCommand({ TableName: tableName }));
  console.log(`[dynamodb] Deleted: ${tableName}`);
}
