/**
 * RDS / Aurora resource module.
 *
 * Supports:
 * - Aurora Serverless v2 (PostgreSQL) — the standard for most apps
 * - Standard RDS instances (for simpler/cheaper apps like naeum)
 * - RDS Proxy
 * - Parameter groups
 * - Secrets Manager integration
 *
 * SAFETY: forge destroy REFUSES on database resources. Manual deletion only.
 */

import {
  RDSClient,
  DescribeDBClustersCommand,
  CreateDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBInstancesCommand,
  CreateDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBParameterGroupsCommand,
  CreateDBParameterGroupCommand,
  ModifyDBParameterGroupCommand,
  DescribeDBParametersCommand,
  DescribeDBClusterParameterGroupsCommand,
  CreateDBClusterParameterGroupCommand,
  ModifyDBClusterParameterGroupCommand,
  DescribeDBProxiesCommand,
  CreateDBProxyCommand,
  RegisterDBProxyTargetsCommand,
  DescribeDBProxyTargetsCommand,
  CreateDBProxyEndpointCommand,
} from '@aws-sdk/client-rds';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  DescribeSecretCommand,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomBytes } from 'crypto';
import type { AwsContext } from '../aws.js';
import type { RdsConfig } from '../config.js';
import type { VpcState } from './vpc.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface RdsState {
  mode: 'aurora-serverless-v2' | 'instance';
  clusterId?: string;
  clusterEndpoint?: string;
  instanceId?: string;
  instanceEndpoint?: string;
  port: number;
  dbName: string;
  masterUsername: string;
  secretArn?: string;
  proxyEndpoint?: string;
  proxyArn?: string;
  parameterGroupName: string;
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeRds(
  ctx: AwsContext,
  config: RdsConfig,
  appName: string
): Promise<RdsState | null> {
  const rds = getClient(ctx, RDSClient);
  const mode = config.mode ?? 'aurora-serverless-v2';

  if (mode === 'aurora-serverless-v2') {
    const clusterId = `${appName}-aurora`;
    try {
      const res = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }));
      const cluster = res.DBClusters?.[0];
      if (!cluster) return null;

      // Check for proxy
      let proxyEndpoint: string | undefined;
      let proxyArn: string | undefined;
      try {
        const proxyRes = await rds.send(new DescribeDBProxiesCommand({
          Filters: [{ Name: 'db-cluster-id', Values: [clusterId] }],
        }));
        // Filter didn't work? Try by name
        if (!proxyRes.DBProxies?.length) {
          const proxyByName = await rds.send(new DescribeDBProxiesCommand({
            DBProxyName: `${appName}-proxy`,
          }));
          if (proxyByName.DBProxies?.length) {
            proxyEndpoint = proxyByName.DBProxies[0].Endpoint;
            proxyArn = proxyByName.DBProxies[0].DBProxyArn;
          }
        } else {
          proxyEndpoint = proxyRes.DBProxies[0].Endpoint;
          proxyArn = proxyRes.DBProxies[0].DBProxyArn;
        }
      } catch {
        // Proxy doesn't exist
      }

      return {
        mode: 'aurora-serverless-v2',
        clusterId,
        clusterEndpoint: cluster.Endpoint,
        port: cluster.Port ?? 5432,
        dbName: cluster.DatabaseName ?? config.dbName,
        masterUsername: cluster.MasterUsername ?? `${appName}_admin`,
        secretArn: cluster.MasterUserSecret?.SecretArn,
        proxyEndpoint,
        proxyArn,
        parameterGroupName: cluster.DBClusterParameterGroup ?? '',
      };
    } catch (err: any) {
      if (err.name === 'DBClusterNotFoundFault') return null;
      throw err;
    }
  } else {
    // Standard RDS instance
    const instanceId = `${appName}-db`;
    try {
      const res = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }));
      const instance = res.DBInstances?.[0];
      if (!instance) return null;

      return {
        mode: 'instance',
        instanceId,
        instanceEndpoint: instance.Endpoint?.Address,
        port: instance.Endpoint?.Port ?? 5432,
        dbName: instance.DBName ?? config.dbName,
        masterUsername: instance.MasterUsername ?? `${appName}_admin`,
        parameterGroupName: instance.DBParameterGroups?.[0]?.DBParameterGroupName ?? '',
      };
    } catch (err: any) {
      if (err.name === 'DBInstanceNotFoundFault') return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planRds(
  ctx: AwsContext,
  config: RdsConfig,
  appName: string,
  plan: Plan
): Promise<RdsState | null> {
  const current = await describeRds(ctx, config, appName);
  const mode = config.mode ?? 'aurora-serverless-v2';
  const resourceId = mode === 'aurora-serverless-v2' ? `${appName}-aurora` : `${appName}-db`;

  if (current) {
    // Check for drift
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

    if (mode === 'aurora-serverless-v2') {
      // Could check min/max capacity, engine version, etc.
      // For now, just report unchanged
    }

    if (config.proxy && !current.proxyEndpoint) {
      fields.push({ field: 'proxy', current: 'none', desired: 'enabled' });
    }

    addChange(plan, {
      resourceType: 'rds',
      resourceId,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'data',
      fields,
    });
    return current;
  }

  // Needs creation
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [
    { field: 'mode', current: undefined, desired: mode },
    { field: 'engine', current: undefined, desired: `postgres ${config.engineVersion ?? '16.4'}` },
    { field: 'dbName', current: undefined, desired: config.dbName },
  ];

  if (mode === 'aurora-serverless-v2') {
    fields.push(
      { field: 'minCapacity', current: undefined, desired: config.minCapacity ?? 0.5 },
      { field: 'maxCapacity', current: undefined, desired: config.maxCapacity ?? 4 },
    );
  } else {
    fields.push(
      { field: 'instanceClass', current: undefined, desired: config.instanceClass ?? 'db.t4g.micro' },
      { field: 'storage', current: undefined, desired: `${config.storage ?? 20}GB` },
    );
  }

  if (config.proxy !== false) {
    fields.push({ field: 'proxy', current: undefined, desired: 'enabled' });
  }

  addChange(plan, {
    resourceType: 'rds',
    resourceId,
    changeType: 'create',
    tier: 'data',
    fields,
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function ensureParameterGroup(
  rds: RDSClient,
  appName: string,
  mode: 'aurora-serverless-v2' | 'instance',
  engineVersion: string,
  forceSsl: boolean
): Promise<string> {
  const family = mode === 'aurora-serverless-v2'
    ? `aurora-postgresql${engineVersion.split('.')[0]}`
    : `postgres${engineVersion.split('.')[0]}`;
  const pgName = `${appName}-${family}-ssl`;
  const isCluster = mode === 'aurora-serverless-v2';

  try {
    if (isCluster) {
      await rds.send(new DescribeDBClusterParameterGroupsCommand({
        DBClusterParameterGroupName: pgName,
      }));
    } else {
      await rds.send(new DescribeDBParameterGroupsCommand({
        DBParameterGroupName: pgName,
      }));
    }
    console.log(`[rds] Parameter group exists: ${pgName}`);
  } catch (err: any) {
    if (err.name === 'DBParameterGroupNotFoundFault' || err.name === 'DBClusterParameterGroupNotFoundFault') {
      console.log(`[rds] Creating parameter group: ${pgName}`);
      if (isCluster) {
        await rds.send(new CreateDBClusterParameterGroupCommand({
          DBClusterParameterGroupName: pgName,
          DBParameterGroupFamily: family,
          Description: `${appName} ${family} - force SSL`,
          Tags: [{ Key: 'app', Value: appName }, { Key: 'managed-by', Value: 'forge' }],
        }));
      } else {
        await rds.send(new CreateDBParameterGroupCommand({
          DBParameterGroupName: pgName,
          DBParameterGroupFamily: family,
          Description: `${appName} ${family} - force SSL`,
          Tags: [{ Key: 'app', Value: appName }, { Key: 'managed-by', Value: 'forge' }],
        }));
      }
    } else {
      throw err;
    }
  }

  if (forceSsl) {
    console.log(`[rds] Ensuring rds.force_ssl = 1 on ${pgName}`);
    if (isCluster) {
      await rds.send(new ModifyDBClusterParameterGroupCommand({
        DBClusterParameterGroupName: pgName,
        Parameters: [{
          ParameterName: 'rds.force_ssl',
          ParameterValue: '1',
          ApplyMethod: 'pending-reboot',
        }],
      }));
    } else {
      await rds.send(new ModifyDBParameterGroupCommand({
        DBParameterGroupName: pgName,
        Parameters: [{
          ParameterName: 'rds.force_ssl',
          ParameterValue: '1',
          ApplyMethod: 'pending-reboot',
        }],
      }));
    }
  }

  return pgName;
}

async function ensureSecret(
  ctx: AwsContext,
  appName: string,
  username: string,
  password: string
): Promise<string> {
  const sm = getClient(ctx, SecretsManagerClient);
  const secretName = `${appName}/aurora-credentials`;

  try {
    const desc = await sm.send(new DescribeSecretCommand({ SecretId: secretName }));
    console.log(`[rds] Secret exists: ${secretName}`);
    return desc.ARN!;
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }

  console.log(`[rds] Creating secret: ${secretName}`);
  const res = await sm.send(new CreateSecretCommand({
    Name: secretName,
    SecretString: JSON.stringify({
      username,
      password,
      engine: 'postgres',
      host: 'PENDING',  // Updated after cluster/instance is available
      port: 5432,
      dbname: appName,
    }),
    Tags: [{ Key: 'app', Value: appName }, { Key: 'managed-by', Value: 'forge' }],
  }));
  return res.ARN!;
}

async function ensureProxyRole(
  ctx: AwsContext,
  appName: string,
  secretArn: string
): Promise<string> {
  const iam = getClient(ctx, IAMClient);
  const roleName = `${appName}-rds-proxy-role`;

  try {
    const res = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    console.log(`[rds] Proxy IAM role exists: ${roleName}`);
    return res.Role!.Arn!;
  } catch (err: any) {
    if (err.name !== 'NoSuchEntityException') throw err;
  }

  console.log(`[rds] Creating proxy IAM role: ${roleName}`);
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'rds.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });

  const createRes = await iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: trustPolicy,
    Description: `RDS Proxy role for ${appName}`,
    Tags: [{ Key: 'app', Value: appName }],
  }));

  // Inline policy for Secrets Manager access
  const { PutRolePolicyCommand } = await import('@aws-sdk/client-iam');
  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: 'secrets-access',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        Resource: [secretArn],
      }],
    }),
  }));

  // Wait for propagation
  console.log('[rds] Waiting for IAM role propagation (10s)...');
  await new Promise(r => setTimeout(r, 10000));

  return createRes.Role!.Arn!;
}

export async function applyRds(
  ctx: AwsContext,
  config: RdsConfig,
  appName: string,
  vpcState: VpcState
): Promise<RdsState> {
  const existing = await describeRds(ctx, config, appName);
  if (existing && (existing.proxyEndpoint || config.proxy === false)) {
    console.log(`[rds] ${existing.clusterId ?? existing.instanceId} — no changes needed`);
    return existing;
  }

  const rds = getClient(ctx, RDSClient);
  const mode = config.mode ?? 'aurora-serverless-v2';
  const engineVersion = config.engineVersion ?? (mode === 'aurora-serverless-v2' ? '16.4' : '15');
  const forceSsl = config.forceSsl ?? true;
  const masterUsername = config.masterUsername ?? `${appName}_admin`;
  const wantProxy = config.proxy ?? (mode === 'aurora-serverless-v2');

  // Parameter group
  const paramGroupName = await ensureParameterGroup(rds, appName, mode, engineVersion, forceSsl);

  if (mode === 'aurora-serverless-v2') {
    const clusterId = `${appName}-aurora`;

    if (!existing) {
      // Create Aurora cluster
      const password = generatePassword();
      const secretArn = await ensureSecret(ctx, appName, masterUsername, password);

      console.log(`[rds] Creating Aurora Serverless v2 cluster: ${clusterId}`);
      await rds.send(new CreateDBClusterCommand({
        DBClusterIdentifier: clusterId,
        Engine: 'aurora-postgresql',
        EngineVersion: engineVersion,
        MasterUsername: masterUsername,
        MasterUserPassword: password,
        DatabaseName: config.dbName,
        DBClusterParameterGroupName: paramGroupName,
        ServerlessV2ScalingConfiguration: {
          MinCapacity: config.minCapacity ?? 0.5,
          MaxCapacity: config.maxCapacity ?? 4,
        },
        DBSubnetGroupName: vpcState.dbSubnetGroupName,
        VpcSecurityGroupIds: vpcState.securityGroupIds.rds
          ? [vpcState.securityGroupIds.rds]
          : [vpcState.securityGroupIds.default],
        StorageEncrypted: true,
        DeletionProtection: config.deletionProtection ?? false,
        CopyTagsToSnapshot: true,
        BackupRetentionPeriod: 7,
        Tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }));

      // Create writer instance
      const instanceId = `${clusterId}-writer`;
      console.log(`[rds] Creating Serverless v2 writer instance: ${instanceId}`);
      await rds.send(new CreateDBInstanceCommand({
        DBInstanceIdentifier: instanceId,
        DBClusterIdentifier: clusterId,
        DBInstanceClass: 'db.serverless',
        Engine: 'aurora-postgresql',
        Tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }));

      console.log('[rds] Cluster creation initiated. Waiting for endpoint...');

      // Poll for endpoint
      let clusterEndpoint: string | undefined;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 15000));
        try {
          const desc = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }));
          const cluster = desc.DBClusters?.[0];
          if (cluster?.Endpoint && cluster.Status === 'available') {
            clusterEndpoint = cluster.Endpoint;
            console.log(`[rds] Cluster available: ${clusterEndpoint}`);
            break;
          }
          console.log(`[rds] Cluster status: ${cluster?.Status} (${(i + 1) * 15}s)`);
        } catch {
          // Still creating
        }
      }

      if (!clusterEndpoint) {
        console.log('[rds] Cluster still creating. Run forge apply again after it becomes available.');
        return {
          mode: 'aurora-serverless-v2',
          clusterId,
          clusterEndpoint: 'PENDING',
          port: 5432,
          dbName: config.dbName,
          masterUsername,
          secretArn,
          parameterGroupName: paramGroupName,
        };
      }

      // Update secret with real endpoint
      const sm = getClient(ctx, SecretsManagerClient);
      await sm.send(new UpdateSecretCommand({
        SecretId: secretArn,
        SecretString: JSON.stringify({
          username: masterUsername,
          password,
          engine: 'postgres',
          host: clusterEndpoint,
          port: 5432,
          dbname: config.dbName,
        }),
      }));
      console.log('[rds] Secret updated with cluster endpoint');

      // Create proxy if requested
      let proxyEndpoint: string | undefined;
      let proxyArn: string | undefined;
      if (wantProxy) {
        const proxyResult = await createProxy(ctx, rds, appName, clusterId, secretArn, vpcState);
        proxyEndpoint = proxyResult.endpoint;
        proxyArn = proxyResult.arn;
      }

      return {
        mode: 'aurora-serverless-v2',
        clusterId,
        clusterEndpoint,
        port: 5432,
        dbName: config.dbName,
        masterUsername,
        secretArn,
        proxyEndpoint,
        proxyArn,
        parameterGroupName: paramGroupName,
      };
    }

    // Existing cluster but missing proxy
    if (wantProxy && !existing.proxyEndpoint && existing.secretArn) {
      console.log('[rds] Creating missing RDS Proxy');
      const proxyResult = await createProxy(ctx, rds, appName, clusterId, existing.secretArn, vpcState);
      return { ...existing, proxyEndpoint: proxyResult.endpoint, proxyArn: proxyResult.arn };
    }

    return existing;
  }

  // Standard RDS instance (naeum pattern)
  const instanceId = `${appName}-db`;

  if (!existing) {
    const password = generatePassword();

    // Store password
    if (config.passwordStore === 'ssm') {
      const ssm = getClient(ctx, SSMClient);
      await ssm.send(new PutParameterCommand({
        Name: `/${appName}/db-password`,
        Type: 'SecureString',
        Value: password,
        Overwrite: true,
      }));
      console.log(`[rds] Password stored in SSM: /${appName}/db-password`);
    } else {
      await ensureSecret(ctx, appName, masterUsername, password);
    }

    console.log(`[rds] Creating RDS instance: ${instanceId}`);
    await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: instanceId,
      DBInstanceClass: config.instanceClass ?? 'db.t4g.micro',
      Engine: 'postgres',
      EngineVersion: engineVersion,
      MasterUsername: masterUsername,
      MasterUserPassword: password,
      DBName: config.dbName,
      AllocatedStorage: config.storage ?? 20,
      StorageType: 'gp3',
      PubliclyAccessible: false,
      DBParameterGroupName: paramGroupName,
      BackupRetentionPeriod: 7,
      MultiAZ: false,
      StorageEncrypted: true,
      CopyTagsToSnapshot: true,
      DeletionProtection: config.deletionProtection ?? false,
      VpcSecurityGroupIds: vpcState.securityGroupIds.rds
        ? [vpcState.securityGroupIds.rds]
        : [vpcState.securityGroupIds.default],
      Tags: [
        { Key: 'app', Value: appName },
        { Key: 'managed-by', Value: 'forge' },
      ],
    }));

    console.log('[rds] Instance creation initiated. Run forge apply again after it becomes available.');
    return {
      mode: 'instance',
      instanceId,
      instanceEndpoint: 'PENDING',
      port: 5432,
      dbName: config.dbName,
      masterUsername,
      parameterGroupName: paramGroupName,
    };
  }

  console.log(`[rds] ${instanceId} — no changes needed`);
  return existing;
}

async function createProxy(
  ctx: AwsContext,
  rds: RDSClient,
  appName: string,
  clusterId: string,
  secretArn: string,
  vpcState: VpcState
): Promise<{ endpoint: string; arn: string }> {
  const proxyName = `${appName}-proxy`;
  const roleArn = await ensureProxyRole(ctx, appName, secretArn);

  const subnetIds = vpcState.privateSubnetIds.length > 0
    ? vpcState.privateSubnetIds
    : vpcState.publicSubnetIds;

  const sgIds = vpcState.securityGroupIds.rdsProxy
    ? [vpcState.securityGroupIds.rdsProxy]
    : [vpcState.securityGroupIds.default];

  console.log(`[rds] Creating RDS Proxy: ${proxyName}`);
  const proxyRes = await rds.send(new CreateDBProxyCommand({
    DBProxyName: proxyName,
    EngineFamily: 'POSTGRESQL',
    Auth: [{
      AuthScheme: 'SECRETS',
      SecretArn: secretArn,
      IAMAuth: 'DISABLED',
    }],
    RoleArn: roleArn,
    VpcSubnetIds: subnetIds,
    VpcSecurityGroupIds: sgIds,
    RequireTLS: true,
    Tags: [
      { Key: 'app', Value: appName },
      { Key: 'managed-by', Value: 'forge' },
    ],
  }));

  const proxyArn = proxyRes.DBProxy!.DBProxyArn!;

  // Wait for proxy to become available
  console.log('[rds] Waiting for proxy to become available...');
  let proxyEndpoint = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const desc = await rds.send(new DescribeDBProxiesCommand({ DBProxyName: proxyName }));
      const proxy = desc.DBProxies?.[0];
      if (proxy?.Status === 'available') {
        proxyEndpoint = proxy.Endpoint!;
        console.log(`[rds] Proxy available: ${proxyEndpoint}`);
        break;
      }
      console.log(`[rds] Proxy status: ${proxy?.Status} (${(i + 1) * 15}s)`);
    } catch {
      // Still creating
    }
  }

  // Register target
  console.log('[rds] Registering proxy target');
  await rds.send(new RegisterDBProxyTargetsCommand({
    DBProxyName: proxyName,
    DBClusterIdentifiers: [clusterId],
  }));

  return { endpoint: proxyEndpoint, arn: proxyArn };
}

/**
 * Destroy — REFUSED for database resources.
 */
export async function destroyRds(): Promise<never> {
  throw new Error(
    'forge refuses to destroy database resources. Data loss is irreversible.\n' +
    'To delete an RDS instance or Aurora cluster, use the AWS Console or CLI manually.\n' +
    'For Aurora: disable deletion protection, delete instances first, then delete cluster.\n' +
    'For RDS: disable deletion protection, then delete instance.'
  );
}
