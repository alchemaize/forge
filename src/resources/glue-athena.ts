/**
 * Glue + Athena resource module.
 *
 * Two related-but-distinct concepts in one file because they share the
 * same data-stack mental model:
 *
 *   - Glue Database: a logical container for tables backed by S3.
 *     Forge manages the database itself; tables/crawlers/jobs are
 *     adoption-only (their schemas evolve out-of-band via crawl results).
 *
 *   - Athena Workgroup: a query environment with its own result location,
 *     bytes-scanned cutoff (cost protection), and encryption settings.
 *
 * SAFETY: Compute-tier — destroy refused for both (queries / dashboards
 * referencing them break immediately).
 */

import {
  GlueClient,
  GetDatabaseCommand,
  CreateDatabaseCommand,
  UpdateDatabaseCommand,
} from '@aws-sdk/client-glue';
import {
  AthenaClient,
  GetWorkGroupCommand,
  CreateWorkGroupCommand,
  UpdateWorkGroupCommand,
} from '@aws-sdk/client-athena';
import type { AwsContext } from '../aws.js';
import type {
  GlueDatabaseConfig,
  AthenaWorkgroupConfig,
} from '../config.js';
import { getClient, withContext, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

// ===========================================================================
// GLUE DATABASE
// ===========================================================================

export interface GlueDatabaseState {
  name: string;
  description?: string;
  locationUri?: string;
  parameters: Record<string, string>;
}

export async function describeGlueDatabase(
  ctx: AwsContext,
  config: GlueDatabaseConfig
): Promise<GlueDatabaseState | null> {
  const glue: GlueClient = getClient(ctx, GlueClient);
  try {
    const res = await glue.send(new GetDatabaseCommand({ Name: config.name }));
    if (!res.Database) return null;
    return {
      name: res.Database.Name!,
      description: res.Database.Description,
      locationUri: res.Database.LocationUri,
      parameters: res.Database.Parameters ?? {},
    };
  } catch (err: any) {
    if (err.name === 'EntityNotFoundException') return null;
    throw err;
  }
}

export async function planGlueDatabase(
  ctx: AwsContext,
  config: GlueDatabaseConfig,
  _appName: string,
  plan: Plan
): Promise<GlueDatabaseState | null> {
  const current = await describeGlueDatabase(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'glue-database',
      resourceId: config.name,
      changeType: 'create',
      tier: 'data',
      fields: [
        ...(config.description ? [{ field: 'description', current: undefined, desired: config.description }] : []),
        ...(config.locationUri ? [{ field: 'locationUri', current: undefined, desired: config.locationUri }] : []),
      ],
    });
    return null;
  }
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (config.description !== undefined && (current.description ?? '') !== config.description) {
    fields.push({ field: 'description', current: current.description, desired: config.description });
  }
  if (config.locationUri !== undefined && (current.locationUri ?? '') !== config.locationUri) {
    fields.push({ field: 'locationUri', current: current.locationUri, desired: config.locationUri });
  }
  if (config.parameters && canonicalize(current.parameters) !== canonicalize(config.parameters)) {
    fields.push({ field: 'parameters', current: '(differs)', desired: '(config)' });
  }
  addChange(plan, {
    resourceType: 'glue-database',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'data',
    fields,
  });
  return current;
}

export async function applyGlueDatabase(
  ctx: AwsContext,
  config: GlueDatabaseConfig,
  _appName: string
): Promise<GlueDatabaseState> {
  const glue: GlueClient = getClient(ctx, GlueClient);
  const current = await describeGlueDatabase(ctx, config);
  const databaseInput = {
    Name: config.name,
    Description: config.description,
    LocationUri: config.locationUri,
    Parameters: config.parameters,
  };

  if (!current) {
    console.log(`[glue-db] Creating database: ${config.name}`);
    try {
      await glue.send(new CreateDatabaseCommand({
        DatabaseInput: databaseInput,
      }));
    } catch (err) {
      throw withContext(`[glue-db] CreateDatabase ${config.name}`, err);
    }
  } else {
    // Update only when something actually drifts.
    const drifted =
      (config.description !== undefined && (current.description ?? '') !== config.description) ||
      (config.locationUri !== undefined && (current.locationUri ?? '') !== config.locationUri) ||
      (config.parameters && canonicalize(current.parameters) !== canonicalize(config.parameters));
    if (drifted) {
      console.log(`[glue-db] Updating: ${config.name}`);
      try {
        await glue.send(new UpdateDatabaseCommand({
          Name: config.name,
          DatabaseInput: databaseInput,
        }));
      } catch (err) {
        throw withContext(`[glue-db] UpdateDatabase ${config.name}`, err);
      }
    }
  }
  return (await describeGlueDatabase(ctx, config))!;
}

export async function destroyGlueDatabase(): Promise<never> {
  throw new Error(
    'forge refuses to destroy Glue databases. Tables / queries reference\n' +
    'the database name and break immediately on delete.'
  );
}

// ===========================================================================
// ATHENA WORKGROUP
// ===========================================================================

export interface AthenaWorkgroupState {
  name: string;
  state: string;
  description?: string;
  resultLocation?: string;
  bytesScannedCutoff?: number;
}

export async function describeAthenaWorkgroup(
  ctx: AwsContext,
  config: AthenaWorkgroupConfig
): Promise<AthenaWorkgroupState | null> {
  const ath: AthenaClient = getClient(ctx, AthenaClient);
  try {
    const res = await ath.send(new GetWorkGroupCommand({ WorkGroup: config.name }));
    const wg = res.WorkGroup;
    if (!wg) return null;
    return {
      name: wg.Name!,
      state: wg.State ?? 'ENABLED',
      description: wg.Description,
      resultLocation: wg.Configuration?.ResultConfiguration?.OutputLocation,
      bytesScannedCutoff: wg.Configuration?.BytesScannedCutoffPerQuery
        ? Number(wg.Configuration.BytesScannedCutoffPerQuery)
        : undefined,
    };
  } catch (err: any) {
    if (err.name === 'InvalidRequestException' && /not found/i.test(err.message ?? '')) return null;
    throw err;
  }
}

function buildEncryptionConfig(config: AthenaWorkgroupConfig): any {
  if (!config.encryption) return undefined;
  return {
    EncryptionOption: config.encryption.type,
    KmsKey: config.encryption.kmsKey,
  };
}

export async function planAthenaWorkgroup(
  ctx: AwsContext,
  config: AthenaWorkgroupConfig,
  _appName: string,
  plan: Plan
): Promise<AthenaWorkgroupState | null> {
  const current = await describeAthenaWorkgroup(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'athena-workgroup',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [
        ...(config.resultLocation ? [{ field: 'resultLocation', current: undefined, desired: config.resultLocation }] : []),
        ...(config.bytesScannedCutoff ? [{ field: 'bytesScannedCutoff', current: undefined, desired: `${config.bytesScannedCutoff} bytes` }] : []),
      ],
    });
    return null;
  }
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (config.resultLocation && current.resultLocation !== config.resultLocation) {
    fields.push({ field: 'resultLocation', current: current.resultLocation, desired: config.resultLocation });
  }
  if (config.bytesScannedCutoff !== undefined && current.bytesScannedCutoff !== config.bytesScannedCutoff) {
    fields.push({ field: 'bytesScannedCutoff', current: current.bytesScannedCutoff, desired: config.bytesScannedCutoff });
  }
  if (config.state && current.state !== config.state) {
    fields.push({ field: 'state', current: current.state, desired: config.state });
  }
  addChange(plan, {
    resourceType: 'athena-workgroup',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

export async function applyAthenaWorkgroup(
  ctx: AwsContext,
  config: AthenaWorkgroupConfig,
  _appName: string
): Promise<AthenaWorkgroupState> {
  const ath: AthenaClient = getClient(ctx, AthenaClient);
  const current = await describeAthenaWorkgroup(ctx, config);
  const workgroupConfig: any = {
    EnforceWorkGroupConfiguration: false,
    PublishCloudWatchMetricsEnabled: true,
  };
  if (config.resultLocation) {
    workgroupConfig.ResultConfiguration = {
      OutputLocation: config.resultLocation,
      EncryptionConfiguration: buildEncryptionConfig(config),
    };
  }
  if (config.bytesScannedCutoff) {
    workgroupConfig.BytesScannedCutoffPerQuery = config.bytesScannedCutoff;
  }

  if (!current) {
    console.log(`[athena-workgroup] Creating: ${config.name}`);
    try {
      await ath.send(new CreateWorkGroupCommand({
        Name: config.name,
        Description: config.description,
        Configuration: workgroupConfig,
      }));
    } catch (err) {
      throw withContext(`[athena-workgroup] CreateWorkGroup ${config.name}`, err);
    }
  } else {
    console.log(`[athena-workgroup] Updating: ${config.name}`);
    try {
      await ath.send(new UpdateWorkGroupCommand({
        WorkGroup: config.name,
        Description: config.description,
        ConfigurationUpdates: workgroupConfig,
        State: config.state,
      }));
    } catch (err) {
      throw withContext(`[athena-workgroup] UpdateWorkGroup ${config.name}`, err);
    }
  }
  return (await describeAthenaWorkgroup(ctx, config))!;
}

export async function destroyAthenaWorkgroup(): Promise<never> {
  throw new Error(
    'forge refuses to destroy Athena workgroups. Saved queries and result\n' +
    'history vanish; dashboards/scheduled queries break.'
  );
}
