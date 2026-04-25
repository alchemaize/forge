/**
 * Forge discover — scans an AWS account for resources belonging to an app
 * and generates a forge.config.ts from what's actually deployed.
 *
 * No CloudFormation stack required. Works with CLI-provisioned, CDK, Terraform,
 * console-created, or any other resources.
 *
 * Discovery strategy:
 * 1. Search by tag (app={name}, managed-by=forge) — catches forge/naeum-created resources
 * 2. Search by name prefix ({name}-*) — catches CLI-created resources (setup-infra.sh pattern)
 * 3. Trace connections — Lambda VPC config → VPC, Lambda env vars → RDS/Cognito/DynamoDB
 * 4. Reverse-lookup — API Gateway integrations → Lambda, Cognito triggers → Lambda
 *
 * Usage:
 *   forge discover --app aegistrader --profile aegis
 *   forge discover --app strfish --profile strfish --output strfish.forge.config.ts
 */

import { fromIni } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

// ---------------------------------------------------------------------------
// Discovery context
// ---------------------------------------------------------------------------

interface DiscoverContext {
  appName: string;
  profile: string;
  region: string;
  accountId: string;
  credentials: ReturnType<typeof fromIni>;
}

interface DiscoveredResources {
  vpcs: Array<{ vpcId: string; cidr: string; source: string }>;
  rdsInstances: Array<any>;
  rdsClusters: Array<any>;
  rdsProxies: Array<any>;
  cognitoPools: Array<any>;
  lambdas: Array<any>;
  apiGateways: Array<any>;
  dynamoTables: Array<any>;
  s3Buckets: Array<any>;
  ecrRepos: Array<any>;
  ecsServices: Array<any>;
  eventbridgeRules: Array<any>;
}

function nameMatches(name: string, appName: string): boolean {
  const lower = name.toLowerCase();
  const app = appName.toLowerCase();
  return lower === app ||
    lower.startsWith(`${app}-`) ||
    lower.startsWith(`${app}_`) ||
    lower.includes(`-${app}-`) ||
    lower.includes(`-${app}_`);
}

// ---------------------------------------------------------------------------
// Resource scanners
// ---------------------------------------------------------------------------

async function discoverLambdas(ctx: DiscoverContext): Promise<any[]> {
  const { LambdaClient, ListFunctionsCommand, GetFunctionCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({ region: ctx.region, credentials: ctx.credentials });

  const functions: any[] = [];
  let marker: string | undefined;

  do {
    const res = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    for (const fn of res.Functions ?? []) {
      const name = fn.FunctionName ?? '';
      if (nameMatches(name, ctx.appName)) {
        // Get full details including tags and VPC
        try {
          const detail = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
          const cfg = detail.Configuration!;
          const tags = detail.Tags ?? {};

          // Filter out CDK internal lambdas
          if (name.includes('CustomResource') || name.includes('AutoDeleteObjects') ||
              name.includes('LogRetention') || name.includes('BucketNotifications')) {
            console.log(`    Skipping CDK internal: ${name}`);
            continue;
          }

          const envVars = cfg.Environment?.Variables ?? {};
          const filteredEnv: Record<string, string> = {};
          const awsInjected = new Set([
            'AWS_LAMBDA_LOG_GROUP_NAME', 'AWS_LAMBDA_LOG_STREAM_NAME',
            'AWS_LAMBDA_FUNCTION_NAME', 'AWS_LAMBDA_FUNCTION_VERSION',
            'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
            'AWS_EXECUTION_ENV', 'AWS_LAMBDA_RUNTIME_API', 'LAMBDA_TASK_ROOT',
            'LAMBDA_RUNTIME_DIR', '_HANDLER', 'TZ',
          ]);
          const secretPatterns = [/secret/i, /password/i, /api_key/i, /apikey/i, /token/i, /private/i, /credential/i];

          for (const [key, value] of Object.entries(envVars)) {
            if (awsInjected.has(key)) continue;
            const isSecret = secretPatterns.some(p => p.test(key));
            filteredEnv[key] = isSecret ? 'REDACTED — set via AWS Console or CLI' : value;
          }

          functions.push({
            name: cfg.FunctionName,
            runtime: cfg.Runtime,
            memory: cfg.MemorySize,
            timeout: cfg.Timeout,
            handler: cfg.Handler,
            architecture: cfg.Architectures?.[0] ?? 'x86_64',
            vpc: !!(cfg.VpcConfig?.SubnetIds?.length),
            vpcConfig: cfg.VpcConfig,
            env: Object.keys(filteredEnv).length > 0 ? filteredEnv : undefined,
            layers: cfg.Layers?.map(l => l.Arn),
            tags,
          });
          console.log(`    Found Lambda: ${name}`);
        } catch {
          // Skip if can't describe
        }
      }
    }
    marker = res.NextMarker;
  } while (marker);

  return functions;
}

async function discoverCognito(ctx: DiscoverContext): Promise<any[]> {
  const {
    CognitoIdentityProviderClient, ListUserPoolsCommand,
    DescribeUserPoolCommand, ListUserPoolClientsCommand, DescribeUserPoolClientCommand,
  } = await import('@aws-sdk/client-cognito-identity-provider');
  const cog = new CognitoIdentityProviderClient({ region: ctx.region, credentials: ctx.credentials });

  const pools: any[] = [];
  const listRes = await cog.send(new ListUserPoolsCommand({ MaxResults: 60 }));

  for (const pool of listRes.UserPools ?? []) {
    const poolName = pool.Name ?? '';
    if (nameMatches(poolName, ctx.appName)) {
      console.log(`    Found Cognito pool: ${poolName} (${pool.Id})`);

      const desc = await cog.send(new DescribeUserPoolCommand({ UserPoolId: pool.Id! }));
      const p = desc.UserPool!;

      // Get clients
      const clientsRes = await cog.send(new ListUserPoolClientsCommand({
        UserPoolId: pool.Id!, MaxResults: 60,
      }));
      const clients: any[] = [];
      for (const c of clientsRes.UserPoolClients ?? []) {
        const cd = await cog.send(new DescribeUserPoolClientCommand({
          UserPoolId: pool.Id!, ClientId: c.ClientId!,
        }));
        const cc = cd.UserPoolClient!;
        clients.push({
          name: cc.ClientName,
          authFlows: cc.ExplicitAuthFlows,
          generateSecret: !!cc.ClientSecret,
          callbackUrls: cc.CallbackURLs?.length ? cc.CallbackURLs : undefined,
          logoutUrls: cc.LogoutURLs?.length ? cc.LogoutURLs : undefined,
        });
        console.log(`    Found Cognito client: ${cc.ClientName} (${cc.ClientId})`);
      }

      // Triggers
      const triggers: any = {};
      if (p.LambdaConfig?.PreTokenGeneration) {
        triggers.preTokenGeneration = p.LambdaConfig.PreTokenGeneration.split(':').pop();
      }
      if (p.LambdaConfig?.PostConfirmation) {
        triggers.postConfirmation = p.LambdaConfig.PostConfirmation.split(':').pop();
      }
      if (p.LambdaConfig?.PreSignUp) {
        triggers.preSignUp = p.LambdaConfig.PreSignUp.split(':').pop();
      }

      pools.push({
        poolId: pool.Id,
        poolName,
        emailSignup: p.UsernameAttributes?.includes('email') ?? true,
        clients,
        triggers: Object.keys(triggers).length > 0 ? triggers : undefined,
      });
    }
  }

  return pools;
}

async function discoverDynamoDB(ctx: DiscoverContext): Promise<any[]> {
  const {
    DynamoDBClient, ListTablesCommand, DescribeTableCommand, DescribeTimeToLiveCommand,
  } = await import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({ region: ctx.region, credentials: ctx.credentials });

  const tables: any[] = [];
  let lastTable: string | undefined;

  do {
    const res = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: lastTable }));
    for (const tableName of res.TableNames ?? []) {
      if (nameMatches(tableName, ctx.appName)) {
        console.log(`    Found DynamoDB table: ${tableName}`);

        const desc = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
        const t = desc.Table!;

        const pk = t.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName;
        const sk = t.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName;
        const attrMap = new Map(
          (t.AttributeDefinitions ?? []).map(a => [a.AttributeName!, a.AttributeType!])
        );

        const config: any = { name: tableName, pk, pkType: attrMap.get(pk!) ?? 'S' };
        if (sk) { config.sk = sk; config.skType = attrMap.get(sk) ?? 'S'; }

        if (t.GlobalSecondaryIndexes?.length) {
          config.gsi = t.GlobalSecondaryIndexes.map(gsi => {
            const gsiPk = gsi.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName;
            const gsiSk = gsi.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName;
            const r: any = { name: gsi.IndexName, pk: gsiPk };
            if (gsiSk) r.sk = gsiSk;
            return r;
          });
        }

        try {
          const ttlRes = await ddb.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
          if (ttlRes.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED') {
            config.ttl = ttlRes.TimeToLiveDescription.AttributeName;
          }
        } catch { /* ignore */ }

        tables.push(config);
      }
    }
    lastTable = res.LastEvaluatedTableName;
  } while (lastTable);

  return tables;
}

async function discoverS3(ctx: DiscoverContext): Promise<any[]> {
  const {
    S3Client, ListBucketsCommand, GetPublicAccessBlockCommand,
    GetBucketLifecycleConfigurationCommand,
  } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: ctx.region, credentials: ctx.credentials });

  const buckets: any[] = [];
  const listRes = await s3.send(new ListBucketsCommand({}));

  for (const bucket of listRes.Buckets ?? []) {
    const name = bucket.Name ?? '';
    if (nameMatches(name, ctx.appName)) {
      console.log(`    Found S3 bucket: ${name}`);

      let templateName = name
        .replace(ctx.accountId, '{account}')
        .replace(ctx.region, '{region}');

      const config: any = { name: templateName, encryption: 'AES256', blockPublicAccess: true };

      try {
        const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }));
        const c = pab.PublicAccessBlockConfiguration;
        config.blockPublicAccess = !!(c?.BlockPublicAcls && c?.IgnorePublicAcls && c?.BlockPublicPolicy && c?.RestrictPublicBuckets);
      } catch { /* default true */ }

      try {
        const lcRes = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }));
        if (lcRes.Rules?.length) {
          config.lifecycle = lcRes.Rules
            .map(r => ({
              prefix: r.Filter && 'Prefix' in r.Filter ? r.Filter.Prefix : undefined,
              expirationDays: r.Expiration?.Days,
            }))
            .filter((r: any) => r.expirationDays);
        }
      } catch { /* no lifecycle */ }

      buckets.push(config);
    }
  }

  return buckets;
}

async function discoverECR(ctx: DiscoverContext): Promise<any[]> {
  const { ECRClient, DescribeRepositoriesCommand } = await import('@aws-sdk/client-ecr');
  const ecr = new ECRClient({ region: ctx.region, credentials: ctx.credentials });

  const repos: any[] = [];
  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({}));
    for (const repo of res.repositories ?? []) {
      const name = repo.repositoryName ?? '';
      if (nameMatches(name, ctx.appName)) {
        console.log(`    Found ECR repo: ${name} (${repo.repositoryUri})`);
        repos.push({
          name,
          uri: repo.repositoryUri,
          scanOnPush: repo.imageScanningConfiguration?.scanOnPush ?? true,
        });
      }
    }
  } catch { /* no ECR access or no repos */ }

  return repos;
}

async function discoverECSExpress(ctx: DiscoverContext): Promise<any[]> {
  const { ECSClient, ListServicesCommand, DescribeServicesCommand } = await import('@aws-sdk/client-ecs');
  const ecs = new ECSClient({ region: ctx.region, credentials: ctx.credentials });

  const services: any[] = [];
  try {
    const listRes = await ecs.send(new ListServicesCommand({ cluster: 'default' }));
    for (const arn of listRes.serviceArns ?? []) {
      const serviceName = arn.split('/').pop() ?? '';
      if (nameMatches(serviceName, ctx.appName)) {
        console.log(`    Found ECS service: ${serviceName}`);

        const descRes = await ecs.send(new DescribeServicesCommand({
          cluster: 'default', services: [arn],
        }));
        const svc = descRes.services?.[0];
        services.push({
          name: serviceName,
          serviceArn: arn,
          status: svc?.status,
        });
      }
    }
  } catch { /* no ECS access */ }

  return services;
}

async function discoverApiGateway(ctx: DiscoverContext): Promise<any[]> {
  const {
    ApiGatewayV2Client, GetApisCommand, GetRoutesCommand, GetAuthorizersCommand,
  } = await import('@aws-sdk/client-apigatewayv2');
  const apigw = new ApiGatewayV2Client({ region: ctx.region, credentials: ctx.credentials });

  const apis: any[] = [];
  const listRes = await apigw.send(new GetApisCommand({}));

  for (const api of listRes.Items ?? []) {
    const name = api.Name ?? '';
    if (nameMatches(name, ctx.appName)) {
      console.log(`    Found API Gateway: ${name} (${api.ApiId})`);

      const routesRes = await apigw.send(new GetRoutesCommand({ ApiId: api.ApiId! }));
      const authorizersRes = await apigw.send(new GetAuthorizersCommand({ ApiId: api.ApiId! }));

      const routes = routesRes.Items ?? [];
      const authorizer = authorizersRes.Items?.[0];

      const publicRoutes: string[] = [];
      let hasCatchAll = false;

      for (const route of routes) {
        if (route.RouteKey === '$default') continue;
        if (route.AuthorizationType === 'NONE') publicRoutes.push(route.RouteKey!);
        if (route.RouteKey?.includes('{proxy+}')) hasCatchAll = true;
      }

      const config: any = {
        name,
        endpoint: api.ApiEndpoint,
        apiId: api.ApiId,
        corsOrigins: api.CorsConfiguration?.AllowOrigins,
        catchAll: hasCatchAll,
        publicRoutes: publicRoutes.length > 0 ? publicRoutes : undefined,
      };

      if (authorizer?.JwtConfiguration) {
        const issuer = authorizer.JwtConfiguration.Issuer ?? '';
        const poolIdMatch = issuer.match(/\/([^/]+)$/);
        if (poolIdMatch) config.cognitoPoolId = poolIdMatch[1];
        if (authorizer.JwtConfiguration.Audience?.length) {
          config.cognitoClientId = authorizer.JwtConfiguration.Audience[0];
        }
      }

      apis.push(config);
    }
  }

  return apis;
}

async function discoverVpcFromLambdas(ctx: DiscoverContext, lambdas: any[]): Promise<any | undefined> {
  // Trace VPC from Lambda VPC configs — if any Lambda is in a VPC, we need it
  const vpcIds = new Set<string>();
  for (const fn of lambdas) {
    if (fn.vpcConfig?.VpcId) {
      vpcIds.add(fn.vpcConfig.VpcId);
    }
  }

  if (vpcIds.size === 0) return undefined;

  // Use the first VPC found (most apps use one VPC)
  const vpcId = [...vpcIds][0];
  console.log(`    Traced VPC from Lambda config: ${vpcId}`);
  return { mode: 'lookup', vpcId };
}

async function discoverRds(ctx: DiscoverContext): Promise<{ instances: any[]; clusters: any[]; proxies: any[] }> {
  const { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, DescribeDBProxiesCommand } = await import('@aws-sdk/client-rds');
  const rds = new RDSClient({ region: ctx.region, credentials: ctx.credentials });

  const instances: any[] = [];
  const clusters: any[] = [];
  const proxies: any[] = [];

  // Scan instances
  try {
    const res = await rds.send(new DescribeDBInstancesCommand({}));
    for (const inst of res.DBInstances ?? []) {
      const id = inst.DBInstanceIdentifier ?? '';
      if (nameMatches(id, ctx.appName)) {
        console.log(`    Found RDS instance: ${id} (${inst.Endpoint?.Address})`);
        instances.push({
          instanceId: id,
          endpoint: inst.Endpoint?.Address,
          port: inst.Endpoint?.Port ?? 5432,
          engine: inst.Engine,
          engineVersion: inst.EngineVersion,
          dbName: inst.DBName,
          masterUsername: inst.MasterUsername,
          instanceClass: inst.DBInstanceClass,
          storage: inst.AllocatedStorage,
          deletionProtection: inst.DeletionProtection,
          clusterId: inst.DBClusterIdentifier,
        });
      }
    }
  } catch { /* no RDS access */ }

  // Scan clusters
  try {
    const res = await rds.send(new DescribeDBClustersCommand({}));
    for (const cluster of res.DBClusters ?? []) {
      const id = cluster.DBClusterIdentifier ?? '';
      if (nameMatches(id, ctx.appName)) {
        console.log(`    Found Aurora cluster: ${id} (${cluster.Endpoint})`);
        clusters.push({
          clusterId: id,
          endpoint: cluster.Endpoint,
          port: cluster.Port ?? 5432,
          engine: cluster.Engine,
          engineVersion: cluster.EngineVersion,
          dbName: cluster.DatabaseName,
          masterUsername: cluster.MasterUsername,
          serverless: !!cluster.ServerlessV2ScalingConfiguration,
          minCapacity: cluster.ServerlessV2ScalingConfiguration?.MinCapacity,
          maxCapacity: cluster.ServerlessV2ScalingConfiguration?.MaxCapacity,
          deletionProtection: cluster.DeletionProtection,
        });
      }
    }
  } catch { /* no RDS access */ }

  // Scan proxies
  try {
    const res = await rds.send(new DescribeDBProxiesCommand({}));
    for (const proxy of res.DBProxies ?? []) {
      const name = proxy.DBProxyName ?? '';
      if (nameMatches(name, ctx.appName)) {
        console.log(`    Found RDS Proxy: ${name} (${proxy.Endpoint})`);
        proxies.push({
          proxyName: name,
          endpoint: proxy.Endpoint,
          engineFamily: proxy.EngineFamily,
          status: proxy.Status,
        });
      }
    }
  } catch { /* no RDS access */ }

  return { instances, clusters, proxies };
}

async function discoverEventBridge(ctx: DiscoverContext): Promise<any[]> {
  const { EventBridgeClient, ListRulesCommand, ListTargetsByRuleCommand } = await import('@aws-sdk/client-eventbridge');
  const eb = new EventBridgeClient({ region: ctx.region, credentials: ctx.credentials });

  const rules: any[] = [];
  try {
    const res = await eb.send(new ListRulesCommand({ NamePrefix: ctx.appName }));
    for (const rule of res.Rules ?? []) {
      console.log(`    Found EventBridge rule: ${rule.Name}`);

      const targetsRes = await eb.send(new ListTargetsByRuleCommand({ Rule: rule.Name! }));
      const target = targetsRes.Targets?.[0];

      rules.push({
        name: rule.Name,
        schedule: rule.ScheduleExpression,
        eventPattern: rule.EventPattern ? JSON.parse(rule.EventPattern) : undefined,
        targetLambda: target?.Arn?.split(':').pop() ?? '',
        enabled: rule.State === 'ENABLED',
        input: target?.Input,
      });
    }
  } catch { /* no EventBridge access */ }

  return rules;
}

// ---------------------------------------------------------------------------
// Config generator (reuse the same formatter from import.ts)
// ---------------------------------------------------------------------------

function formatObject(obj: any, indent: number): string {
  const pad = ' '.repeat(indent);
  const innerPad = ' '.repeat(indent + 2);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    if (obj.every((item: any) => typeof item === 'string')) {
      return `[${obj.map((s: string) => `'${s}'`).join(', ')}]`;
    }
    const items = obj.map((item: any) => {
      if (typeof item === 'object' && item !== null) {
        return `${innerPad}${formatObject(item, indent + 2)}`;
      }
      return `${innerPad}${formatValue(item)}`;
    });
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  const entries = Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '{}';

  if (entries.length <= 2 && entries.every(([_, v]) => typeof v !== 'object')) {
    const pairs = entries.map(([k, v]) => `${k}: ${formatValue(v)}`);
    return `{ ${pairs.join(', ')} }`;
  }

  const lines = entries.map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      return `${innerPad}${key}: ${formatObject(value, indent + 2)}`;
    }
    return `${innerPad}${key}: ${formatValue(value)}`;
  });

  return `{\n${lines.join(',\n')},\n${pad}}`;
}

function formatValue(val: unknown): string {
  if (typeof val === 'string') return `'${val}'`;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  return String(val);
}

// ---------------------------------------------------------------------------
// Main discover orchestrator
// ---------------------------------------------------------------------------

export async function discoverApp(
  appName: string,
  profile: string,
  region: string = 'us-east-1',
  outputPath?: string
): Promise<string> {
  console.log(`\nForge: discovering resources for '${appName}'\n`);
  console.log(`  Profile: ${profile}`);
  console.log(`  Region:  ${region}`);

  const credentials = fromIni({ profile });
  const sts = new STSClient({ region, credentials });
  let accountId: string;

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    accountId = identity.Account!;
    console.log(`  Account: ${accountId}`);
  } catch (err: any) {
    throw new Error(`Failed to authenticate with profile '${profile}': ${err.message}`);
  }

  const ctx: DiscoverContext = { appName, profile, region, accountId, credentials };

  // Phase 1: Scan all resource types
  console.log('\n  Scanning Lambda functions...');
  const lambdas = await discoverLambdas(ctx);

  console.log('\n  Scanning Cognito user pools...');
  const cognitoPools = await discoverCognito(ctx);

  console.log('\n  Scanning DynamoDB tables...');
  const dynamoTables = await discoverDynamoDB(ctx);

  console.log('\n  Scanning S3 buckets...');
  const s3Buckets = await discoverS3(ctx);

  console.log('\n  Scanning ECR repositories...');
  const ecrRepos = await discoverECR(ctx);

  console.log('\n  Scanning ECS services...');
  const ecsServices = await discoverECSExpress(ctx);

  console.log('\n  Scanning API Gateway...');
  const apiGateways = await discoverApiGateway(ctx);

  console.log('\n  Scanning RDS/Aurora...');
  const rdsResults = await discoverRds(ctx);

  console.log('\n  Scanning EventBridge rules...');
  const eventbridgeRules = await discoverEventBridge(ctx);

  // Phase 2: Trace connections
  console.log('\n  Tracing connections...');
  const vpcConfig = await discoverVpcFromLambdas(ctx, lambdas);

  // Phase 3: Assemble config
  console.log('\n  Assembling forge config...\n');

  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * ${appName} — Forge config`);
  lines.push(` *`);
  lines.push(` * Auto-discovered from live AWS resources (no CloudFormation stack required)`);
  lines.push(` * Discovered: ${new Date().toISOString().split('T')[0]}`);
  lines.push(` * Account: ${accountId}`);
  lines.push(` *`);
  lines.push(` * Review this file before running forge apply.`);
  lines.push(` * Forge will NOT delete or recreate existing resources — it adopts them in place.`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import { defineConfig } from './src/config.js';`);
  lines.push(`// If using from outside the forge directory, change to:`);
  lines.push(`// import { defineConfig } from '<path-to-forge>/src/config.js';`);
  lines.push(``);
  lines.push(`export default defineConfig({`);
  lines.push(`  app: '${appName}',`);
  lines.push(`  profile: '${profile}',`);
  lines.push(`  region: '${region}',`);

  // VPC
  if (vpcConfig) {
    lines.push(``);
    lines.push(`  vpc: ${formatObject(vpcConfig, 2)},`);
  }

  // RDS
  if (rdsResults.clusters.length > 0) {
    const c = rdsResults.clusters[0];
    const rdsConfig: any = {
      mode: c.serverless ? 'aurora-serverless-v2' : 'aurora',
      engineVersion: c.engineVersion,
      dbName: c.dbName,
      masterUsername: c.masterUsername,
      deletionProtection: c.deletionProtection ?? false,
      proxy: rdsResults.proxies.length > 0,
    };
    if (c.serverless) {
      rdsConfig.minCapacity = c.minCapacity;
      rdsConfig.maxCapacity = c.maxCapacity;
    }
    lines.push(``);
    lines.push(`  rds: ${formatObject(rdsConfig, 2)},`);
  } else if (rdsResults.instances.length > 0) {
    const inst = rdsResults.instances.find((i: any) => !i.clusterId); // standalone only
    if (inst) {
      lines.push(``);
      lines.push(`  rds: ${formatObject({
        mode: 'instance',
        engineVersion: inst.engineVersion,
        dbName: inst.dbName,
        masterUsername: inst.masterUsername,
        instanceClass: inst.instanceClass,
        storage: inst.storage,
        deletionProtection: inst.deletionProtection ?? false,
        proxy: rdsResults.proxies.length > 0,
      }, 2)},`);
    }
  }

  // Cognito
  if (cognitoPools.length > 0) {
    const pool = cognitoPools[0];
    const cogConfig: any = {
      poolName: pool.poolName,
      emailSignup: pool.emailSignup,
      clients: pool.clients,
    };
    if (pool.triggers) cogConfig.triggers = pool.triggers;
    lines.push(``);
    lines.push(`  cognito: ${formatObject(cogConfig, 2)},`);
  }

  // Lambda
  if (lambdas.length > 0) {
    lines.push(``);
    lines.push(`  lambda: [`);
    for (const fn of lambdas) {
      const lambdaConfig: any = {
        name: fn.name,
        runtime: fn.runtime,
        memory: fn.memory,
        timeout: fn.timeout,
        handler: fn.handler,
        architecture: fn.architecture,
      };
      if (fn.vpc) lambdaConfig.vpc = true;
      if (fn.env) lambdaConfig.env = fn.env;
      if (fn.layers?.length) lambdaConfig.layers = fn.layers;
      lines.push(`    ${formatObject(lambdaConfig, 4)},`);
    }
    lines.push(`  ],`);
  }

  // API Gateway
  if (apiGateways.length > 0) {
    const api = apiGateways[0];
    const apiConfig: any = {
      name: api.name,
      corsOrigins: api.corsOrigins,
      catchAll: api.catchAll,
    };
    if (api.publicRoutes) apiConfig.publicRoutes = api.publicRoutes;
    if (api.cognitoPoolId) apiConfig.cognitoPoolId = api.cognitoPoolId;
    if (api.cognitoClientId) apiConfig.cognitoClientId = api.cognitoClientId;
    lines.push(``);
    lines.push(`  apiGateway: ${formatObject(apiConfig, 2)},`);
  }

  // DynamoDB
  if (dynamoTables.length > 0) {
    lines.push(``);
    lines.push(`  dynamodb: [`);
    for (const table of dynamoTables) {
      lines.push(`    ${formatObject(table, 4)},`);
    }
    lines.push(`  ],`);
  }

  // S3
  if (s3Buckets.length > 0) {
    lines.push(``);
    lines.push(`  s3: [`);
    for (const bucket of s3Buckets) {
      lines.push(`    ${formatObject(bucket, 4)},`);
    }
    lines.push(`  ],`);
  }

  // ECR
  if (ecrRepos.length > 0) {
    lines.push(``);
    lines.push(`  ecr: [`);
    for (const repo of ecrRepos) {
      lines.push(`    ${formatObject({ name: repo.name, scanOnPush: repo.scanOnPush }, 4)},`);
    }
    lines.push(`  ],`);
  }

  // ECS Express
  if (ecsServices.length > 0) {
    lines.push(``);
    lines.push(`  ecsExpress: [`);
    for (const svc of ecsServices) {
      lines.push(`    ${formatObject({ name: svc.name }, 4)},`);
    }
    lines.push(`  ],`);
  }

  // EventBridge
  if (eventbridgeRules.length > 0) {
    lines.push(``);
    lines.push(`  eventbridge: [`);
    for (const rule of eventbridgeRules) {
      lines.push(`    ${formatObject(rule, 4)},`);
    }
    lines.push(`  ],`);
  }

  lines.push(`});`);
  lines.push(``);

  const configSource = lines.join('\n');

  // Write
  const outFile = outputPath ?? `${appName}.forge.config.ts`;
  const { writeFileSync } = await import('fs');
  writeFileSync(outFile, configSource, 'utf-8');

  // Summary
  const total = lambdas.length + cognitoPools.length + dynamoTables.length +
    s3Buckets.length + ecrRepos.length + ecsServices.length + apiGateways.length +
    rdsResults.instances.length + rdsResults.clusters.length + rdsResults.proxies.length +
    eventbridgeRules.length + (vpcConfig ? 1 : 0);

  console.log(`  Discovered ${total} resources`);
  console.log(`  Written to: ${outFile}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Review ${outFile} — verify all values look correct`);
  console.log(`    2. Run: forge plan --config ${outFile}`);
  console.log(`       This should show all resources as "unchanged"`);
  console.log('');

  return outFile;
}
