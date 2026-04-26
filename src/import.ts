/**
 * Forge import — reads a CloudFormation stack and generates a forge.config.ts.
 *
 * This is the migration bridge from CDK/CloudFormation to forge.
 * It reads every resource in a stack, queries live AWS state for details
 * that CloudFormation doesn't expose, and produces a complete typed config.
 *
 * Usage:
 *   forge import --stack YeonCrm --profile yeoncrm
 *   forge import --stack STRfish --profile strfish --output strfish.forge.config.ts
 */

import { fromIni } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

// ---------------------------------------------------------------------------
// Types for CloudFormation resource extraction
// ---------------------------------------------------------------------------

interface CfnResource {
  LogicalResourceId: string;
  PhysicalResourceId: string;
  ResourceType: string;
  ResourceStatus: string;
}

interface ImportContext {
  stackName: string;
  profile: string;
  region: string;
  accountId: string;
  credentials: ReturnType<typeof fromIni>;
  resources: CfnResource[];
}

interface ImportedConfig {
  app: string;
  profile: string;
  region: string;
  vpc?: any;
  rds?: any;
  cognito?: any;
  lambda?: any[];
  apiGateway?: any;
  dynamodb?: any[];
  s3?: any[];
  ecr?: any[];
  ecsExpress?: any[];
  eventbridge?: any[];
}

// ---------------------------------------------------------------------------
// CloudFormation stack reader
// ---------------------------------------------------------------------------

async function listStackResources(ctx: ImportContext): Promise<CfnResource[]> {
  const { CloudFormationClient, ListStackResourcesCommand } = await import('@aws-sdk/client-cloudformation');
  const cfn = new CloudFormationClient({
    region: ctx.region,
    credentials: ctx.credentials,
  });

  const resources: CfnResource[] = [];
  let nextToken: string | undefined;

  do {
    const res = await cfn.send(new ListStackResourcesCommand({
      StackName: ctx.stackName,
      NextToken: nextToken,
    }));

    for (const r of res.StackResourceSummaries ?? []) {
      resources.push({
        LogicalResourceId: r.LogicalResourceId ?? '',
        PhysicalResourceId: r.PhysicalResourceId ?? '',
        ResourceType: r.ResourceType ?? '',
        ResourceStatus: r.ResourceStatus ?? '',
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return resources;
}

// ---------------------------------------------------------------------------
// Resource-specific importers — query live AWS for full config
// ---------------------------------------------------------------------------

async function importVpc(ctx: ImportContext): Promise<any | undefined> {
  const vpcResources = ctx.resources.filter(r => r.ResourceType === 'AWS::EC2::VPC');
  if (vpcResources.length === 0) return undefined;

  const vpcId = vpcResources[0].PhysicalResourceId;
  console.log(`  [vpc] Found: ${vpcId}`);

  return {
    mode: 'lookup' as const,
    vpcId,
  };
}

async function importRds(ctx: ImportContext): Promise<any | undefined> {
  const clusters = ctx.resources.filter(r => r.ResourceType === 'AWS::RDS::DBCluster');
  const instances = ctx.resources.filter(r => r.ResourceType === 'AWS::RDS::DBInstance');
  const proxies = ctx.resources.filter(r => r.ResourceType === 'AWS::RDS::DBProxy');

  if (clusters.length === 0 && instances.length === 0) return undefined;

  if (clusters.length > 0) {
    // Aurora cluster — query for details
    const clusterId = clusters[0].PhysicalResourceId;
    console.log(`  [rds] Found Aurora cluster: ${clusterId}`);

    const { RDSClient, DescribeDBClustersCommand } = await import('@aws-sdk/client-rds');
    const rds = new RDSClient({ region: ctx.region, credentials: ctx.credentials });

    try {
      const desc = await rds.send(new DescribeDBClustersCommand({
        DBClusterIdentifier: clusterId,
      }));
      const cluster = desc.DBClusters?.[0];

      if (cluster) {
        const isServerless = cluster.ServerlessV2ScalingConfiguration != null;
        const config: any = {
          mode: isServerless ? 'aurora-serverless-v2' : 'instance',
          engineVersion: cluster.EngineVersion,
          dbName: cluster.DatabaseName,
          masterUsername: cluster.MasterUsername,
          deletionProtection: cluster.DeletionProtection ?? false,
          passwordStore: 'secrets-manager',
        };

        // If the cluster ID doesn't match Forge's default naming convention
        // ({app}-aurora), emit a clusterId override so describeRds can find it.
        const expectedId = `${ctx.stackName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')}-aurora`;
        if (clusterId !== expectedId) {
          config.clusterId = clusterId;
        }

        if (isServerless) {
          config.minCapacity = cluster.ServerlessV2ScalingConfiguration?.MinCapacity;
          config.maxCapacity = cluster.ServerlessV2ScalingConfiguration?.MaxCapacity;
        }

        if (proxies.length > 0) {
          config.proxy = true;
          console.log(`  [rds] Found RDS Proxy: ${proxies[0].PhysicalResourceId}`);
        }

        return config;
      }
    } catch (err: any) {
      console.log(`  [rds] Warning: could not describe cluster ${clusterId}: ${err.message}`);
    }
  }

  if (instances.length > 0 && clusters.length === 0) {
    // Standalone RDS instance
    const instanceId = instances[0].PhysicalResourceId;
    console.log(`  [rds] Found RDS instance: ${instanceId}`);

    const { RDSClient, DescribeDBInstancesCommand } = await import('@aws-sdk/client-rds');
    const rds = new RDSClient({ region: ctx.region, credentials: ctx.credentials });

    try {
      const desc = await rds.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: instanceId,
      }));
      const instance = desc.DBInstances?.[0];

      if (instance) {
        return {
          mode: 'instance' as const,
          engineVersion: instance.EngineVersion,
          dbName: instance.DBName,
          masterUsername: instance.MasterUsername,
          instanceClass: instance.DBInstanceClass,
          storage: instance.AllocatedStorage,
          deletionProtection: instance.DeletionProtection ?? false,
          proxy: proxies.length > 0,
        };
      }
    } catch (err: any) {
      console.log(`  [rds] Warning: could not describe instance ${instanceId}: ${err.message}`);
    }
  }

  return undefined;
}

async function importCognito(ctx: ImportContext): Promise<any | undefined> {
  const pools = ctx.resources.filter(r => r.ResourceType === 'AWS::Cognito::UserPool');
  if (pools.length === 0) return undefined;

  const poolId = pools[0].PhysicalResourceId;
  console.log(`  [cognito] Found user pool: ${poolId}`);

  const {
    CognitoIdentityProviderClient,
    DescribeUserPoolCommand,
    ListUserPoolClientsCommand,
    DescribeUserPoolClientCommand,
  } = await import('@aws-sdk/client-cognito-identity-provider');

  const cog = new CognitoIdentityProviderClient({
    region: ctx.region,
    credentials: ctx.credentials,
  });

  try {
    const poolDesc = await cog.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    const pool = poolDesc.UserPool;

    // Get clients
    const clientsRes = await cog.send(new ListUserPoolClientsCommand({
      UserPoolId: poolId,
      MaxResults: 60,
    }));

    const clients: any[] = [];
    for (const c of clientsRes.UserPoolClients ?? []) {
      const clientDesc = await cog.send(new DescribeUserPoolClientCommand({
        UserPoolId: poolId,
        ClientId: c.ClientId!,
      }));
      const cc = clientDesc.UserPoolClient;
      clients.push({
        name: cc?.ClientName,
        authFlows: cc?.ExplicitAuthFlows,
        generateSecret: !!cc?.ClientSecret,
        callbackUrls: cc?.CallbackURLs?.length ? cc.CallbackURLs : undefined,
        logoutUrls: cc?.LogoutURLs?.length ? cc.LogoutURLs : undefined,
      });
      console.log(`  [cognito] Found client: ${cc?.ClientName} (${cc?.ClientId})`);
    }

    // Extract triggers
    const triggers: any = {};
    const lambdaConfig = pool?.LambdaConfig;
    if (lambdaConfig?.PreTokenGeneration) {
      // Extract function name from ARN
      triggers.preTokenGeneration = lambdaConfig.PreTokenGeneration.split(':').pop();
      console.log(`  [cognito] PreTokenGeneration trigger: ${triggers.preTokenGeneration}`);
    }
    if (lambdaConfig?.PostConfirmation) {
      triggers.postConfirmation = lambdaConfig.PostConfirmation.split(':').pop();
      console.log(`  [cognito] PostConfirmation trigger: ${triggers.postConfirmation}`);
    }
    if (lambdaConfig?.PreSignUp) {
      triggers.preSignUp = lambdaConfig.PreSignUp.split(':').pop();
    }
    if (lambdaConfig?.CustomMessage) {
      triggers.customMessage = lambdaConfig.CustomMessage.split(':').pop();
    }

    const config: any = {
      poolName: pool?.Name,
      emailSignup: pool?.UsernameAttributes?.includes('email') ?? true,
      clients,
    };

    if (Object.keys(triggers).length > 0) {
      config.triggers = triggers;
    }

    // Check for email sender config
    if (pool?.EmailConfiguration?.SourceArn) {
      config.emailSender = pool.EmailConfiguration.EmailSendingAccount === 'DEVELOPER'
        ? pool.EmailConfiguration.From ?? pool.EmailConfiguration.SourceArn
        : undefined;
    }

    return config;
  } catch (err: any) {
    console.log(`  [cognito] Warning: could not describe pool ${poolId}: ${err.message}`);
    return undefined;
  }
}

async function importLambdas(ctx: ImportContext): Promise<any[]> {
  const lambdaResources = ctx.resources.filter(r => r.ResourceType === 'AWS::Lambda::Function');
  if (lambdaResources.length === 0) return [];

  const { LambdaClient, GetFunctionCommand } = await import('@aws-sdk/client-lambda');
  const lam = new LambdaClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];

  for (const lr of lambdaResources) {
    const functionName = lr.PhysicalResourceId;

    // Skip CDK internal Lambdas — these are plumbing, not app resources
    const logicalId = lr.LogicalResourceId.toLowerCase();
    if (logicalId.includes('customresource') ||
        logicalId.includes('autodelete') ||
        logicalId.includes('bucketnotifications') ||
        logicalId.includes('logretention') ||
        logicalId.includes('awscustomresource') ||
        logicalId.includes('provider') ||
        logicalId.includes('framework')) {
      console.log(`  [lambda] Skipping CDK internal: ${functionName}`);
      continue;
    }

    console.log(`  [lambda] Found: ${functionName}`);

    try {
      const desc = await lam.send(new GetFunctionCommand({ FunctionName: functionName }));
      const cfg = desc.Configuration;

      if (!cfg) continue;

      const lambdaConfig: any = {
        name: cfg.FunctionName,
        runtime: cfg.Runtime,
        memory: cfg.MemorySize,
        timeout: cfg.Timeout,
        handler: cfg.Handler,
        architecture: cfg.Architectures?.[0] ?? 'x86_64',
      };

      // Check if in VPC
      if (cfg.VpcConfig?.SubnetIds?.length) {
        lambdaConfig.vpc = true;
      }

      // Environment variables (exclude AWS-injected ones)
      const envVars = cfg.Environment?.Variables ?? {};
      const filteredEnv: Record<string, string> = {};
      const awsInjected = new Set([
        'AWS_LAMBDA_LOG_GROUP_NAME', 'AWS_LAMBDA_LOG_STREAM_NAME',
        'AWS_LAMBDA_FUNCTION_NAME', 'AWS_LAMBDA_FUNCTION_VERSION',
        'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
        'AWS_EXECUTION_ENV', 'AWS_LAMBDA_RUNTIME_API', 'LAMBDA_TASK_ROOT',
        'LAMBDA_RUNTIME_DIR', '_HANDLER', 'TZ',
      ]);

      // Patterns that indicate secrets — redact the value
      const secretPatterns = [
        /secret/i, /password/i, /api_key/i, /apikey/i, /token/i,
        /private/i, /credential/i,
      ];

      for (const [key, value] of Object.entries(envVars)) {
        if (awsInjected.has(key)) continue;

        const isSecret = secretPatterns.some(p => p.test(key));
        if (isSecret) {
          filteredEnv[key] = `REDACTED — set via AWS Console or CLI`;
        } else {
          filteredEnv[key] = value;
        }
      }

      if (Object.keys(filteredEnv).length > 0) {
        lambdaConfig.env = filteredEnv;
      }

      // Layers
      if (cfg.Layers?.length) {
        lambdaConfig.layers = cfg.Layers.map(l => l.Arn);
      }

      configs.push(lambdaConfig);
    } catch (err: any) {
      console.log(`  [lambda] Warning: could not describe ${functionName}: ${err.message}`);
    }
  }

  return configs;
}

async function importApiGateway(ctx: ImportContext): Promise<any | undefined> {
  const apiResources = ctx.resources.filter(r => r.ResourceType === 'AWS::ApiGatewayV2::Api');
  if (apiResources.length === 0) return undefined;

  const apiId = apiResources[0].PhysicalResourceId;
  console.log(`  [api-gw] Found HTTP API: ${apiId}`);

  const {
    ApiGatewayV2Client,
    GetApiCommand,
    GetRoutesCommand,
    GetAuthorizersCommand,
  } = await import('@aws-sdk/client-apigatewayv2');

  const apigw = new ApiGatewayV2Client({ region: ctx.region, credentials: ctx.credentials });

  try {
    const apiDesc = await apigw.send(new GetApiCommand({ ApiId: apiId }));
    const routesRes = await apigw.send(new GetRoutesCommand({ ApiId: apiId }));
    const authorizersRes = await apigw.send(new GetAuthorizersCommand({ ApiId: apiId }));

    const routes = routesRes.Items ?? [];
    const authorizer = authorizersRes.Items?.[0];

    // Separate public vs authenticated routes
    const publicRoutes: string[] = [];
    let hasCatchAll = false;

    for (const route of routes) {
      if (route.RouteKey === '$default') continue;

      if (route.AuthorizationType === 'NONE') {
        publicRoutes.push(route.RouteKey!);
      }

      if (route.RouteKey?.includes('{proxy+}')) {
        hasCatchAll = true;
      }
    }

    const config: any = {
      name: apiDesc.Name,
      corsOrigins: apiDesc.CorsConfiguration?.AllowOrigins,
      catchAll: hasCatchAll,
      publicRoutes: publicRoutes.length > 0 ? publicRoutes : undefined,
    };

    // Extract Cognito pool/client from JWT authorizer
    if (authorizer?.JwtConfiguration) {
      const issuer = authorizer.JwtConfiguration.Issuer ?? '';
      const poolIdMatch = issuer.match(/\/([^/]+)$/);
      if (poolIdMatch) {
        config.cognitoPoolId = poolIdMatch[1];
      }
      if (authorizer.JwtConfiguration.Audience?.length) {
        config.cognitoClientId = authorizer.JwtConfiguration.Audience[0];
      }
    }

    console.log(`  [api-gw] Endpoint: ${apiDesc.ApiEndpoint}`);
    console.log(`  [api-gw] Routes: ${routes.length} (${publicRoutes.length} public)`);

    return config;
  } catch (err: any) {
    console.log(`  [api-gw] Warning: could not describe API ${apiId}: ${err.message}`);
    return undefined;
  }
}

async function importDynamoDb(ctx: ImportContext): Promise<any[]> {
  const tableResources = ctx.resources.filter(r => r.ResourceType === 'AWS::DynamoDB::Table');
  if (tableResources.length === 0) return [];

  const { DynamoDBClient, DescribeTableCommand, DescribeTimeToLiveCommand } = await import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];

  for (const tr of tableResources) {
    const tableName = tr.PhysicalResourceId;
    console.log(`  [dynamodb] Found: ${tableName}`);

    try {
      const desc = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
      const table = desc.Table;
      if (!table) continue;

      const pk = table.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName;
      const sk = table.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName;

      // Get attribute types
      const attrMap = new Map<string, string>();
      for (const attr of table.AttributeDefinitions ?? []) {
        attrMap.set(attr.AttributeName!, attr.AttributeType!);
      }

      const config: any = {
        name: tableName,
        pk,
        pkType: attrMap.get(pk!) ?? 'S',
      };

      if (sk) {
        config.sk = sk;
        config.skType = attrMap.get(sk) ?? 'S';
      }

      // GSIs
      if (table.GlobalSecondaryIndexes?.length) {
        config.gsi = table.GlobalSecondaryIndexes.map(gsi => {
          const gsiPk = gsi.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName;
          const gsiSk = gsi.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName;
          const result: any = { name: gsi.IndexName, pk: gsiPk };
          if (gsiSk) result.sk = gsiSk;
          if (gsi.Projection?.ProjectionType !== 'ALL') {
            result.projection = gsi.Projection?.ProjectionType;
          }
          return result;
        });
      }

      // TTL
      try {
        const ttlRes = await ddb.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
        if (ttlRes.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED') {
          config.ttl = ttlRes.TimeToLiveDescription.AttributeName;
        }
      } catch {
        // TTL describe failed — not critical
      }

      // Billing mode
      config.billingMode = table.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST';

      configs.push(config);
    } catch (err: any) {
      console.log(`  [dynamodb] Warning: could not describe ${tableName}: ${err.message}`);
    }
  }

  return configs;
}

async function importS3(ctx: ImportContext): Promise<any[]> {
  const bucketResources = ctx.resources.filter(r => r.ResourceType === 'AWS::S3::Bucket');
  if (bucketResources.length === 0) return [];

  const configs: any[] = [];

  for (const br of bucketResources) {
    const bucketName = br.PhysicalResourceId;
    console.log(`  [s3] Found: ${bucketName}`);

    // Replace account ID and region with placeholders for portability
    let templateName = bucketName;
    templateName = templateName.replace(ctx.accountId, '{account}');
    templateName = templateName.replace(ctx.region, '{region}');

    const config: any = {
      name: templateName,
      encryption: 'AES256',
      blockPublicAccess: true,
    };

    // Try to detect if public access is enabled
    const { S3Client, GetPublicAccessBlockCommand, GetBucketLifecycleConfigurationCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: ctx.region, credentials: ctx.credentials });

    try {
      const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }));
      const allBlocked = pab.PublicAccessBlockConfiguration?.BlockPublicAcls &&
        pab.PublicAccessBlockConfiguration?.IgnorePublicAcls &&
        pab.PublicAccessBlockConfiguration?.BlockPublicPolicy &&
        pab.PublicAccessBlockConfiguration?.RestrictPublicBuckets;
      config.blockPublicAccess = !!allBlocked;
    } catch {
      // Default to true
    }

    // Lifecycle rules
    try {
      const lcRes = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
      if (lcRes.Rules?.length) {
        config.lifecycle = lcRes.Rules.map(rule => ({
          prefix: rule.Filter && 'Prefix' in rule.Filter ? rule.Filter.Prefix : undefined,
          expirationDays: rule.Expiration?.Days,
        })).filter((r: any) => r.expirationDays);
      }
    } catch {
      // No lifecycle rules
    }

    configs.push(config);
  }

  return configs;
}

async function importEventBridge(ctx: ImportContext): Promise<any[]> {
  const ruleResources = ctx.resources.filter(r => r.ResourceType === 'AWS::Events::Rule');
  if (ruleResources.length === 0) return [];

  const {
    EventBridgeClient,
    DescribeRuleCommand,
    ListTargetsByRuleCommand,
  } = await import('@aws-sdk/client-eventbridge');
  const eb = new EventBridgeClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];

  for (const rr of ruleResources) {
    const ruleName = rr.PhysicalResourceId;
    console.log(`  [eventbridge] Found rule: ${ruleName}`);

    try {
      const ruleDesc = await eb.send(new DescribeRuleCommand({ Name: ruleName }));
      const targetsRes = await eb.send(new ListTargetsByRuleCommand({ Rule: ruleName }));

      const target = targetsRes.Targets?.[0];
      const targetLambda = target?.Arn?.split(':').pop() ?? '';

      const config: any = {
        name: ruleName,
        targetLambda,
        enabled: ruleDesc.State === 'ENABLED',
      };

      if (ruleDesc.ScheduleExpression) {
        config.schedule = ruleDesc.ScheduleExpression;
      }
      if (ruleDesc.EventPattern) {
        config.eventPattern = JSON.parse(ruleDesc.EventPattern);
      }
      if (target?.Input) {
        config.input = target.Input;
      }

      configs.push(config);
    } catch (err: any) {
      console.log(`  [eventbridge] Warning: could not describe ${ruleName}: ${err.message}`);
    }
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Config file generator
// ---------------------------------------------------------------------------

function generateConfigSource(config: ImportedConfig): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * ${config.app} — Forge config`);
  lines.push(` *`);
  lines.push(` * Auto-generated by: forge import --stack <StackName> --profile ${config.profile}`);
  lines.push(` * Generated: ${new Date().toISOString().split('T')[0]}`);
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
  lines.push(`  app: '${config.app}',`);
  lines.push(`  profile: '${config.profile}',`);
  lines.push(`  region: '${config.region}',`);

  // VPC
  if (config.vpc) {
    lines.push(``);
    lines.push(`  vpc: ${formatObject(config.vpc, 2)},`);
  }

  // RDS
  if (config.rds) {
    lines.push(``);
    lines.push(`  rds: ${formatObject(config.rds, 2)},`);
  }

  // Cognito
  if (config.cognito) {
    lines.push(``);
    lines.push(`  cognito: ${formatObject(config.cognito, 2)},`);
  }

  // Lambda
  if (config.lambda?.length) {
    lines.push(``);
    lines.push(`  lambda: [`);
    for (const lam of config.lambda) {
      lines.push(`    ${formatObject(lam, 4)},`);
    }
    lines.push(`  ],`);
  }

  // API Gateway
  if (config.apiGateway) {
    lines.push(``);
    lines.push(`  apiGateway: ${formatObject(config.apiGateway, 2)},`);
  }

  // DynamoDB
  if (config.dynamodb?.length) {
    lines.push(``);
    lines.push(`  dynamodb: [`);
    for (const table of config.dynamodb) {
      lines.push(`    ${formatObject(table, 4)},`);
    }
    lines.push(`  ],`);
  }

  // S3
  if (config.s3?.length) {
    lines.push(``);
    lines.push(`  s3: [`);
    for (const bucket of config.s3) {
      lines.push(`    ${formatObject(bucket, 4)},`);
    }
    lines.push(`  ],`);
  }

  // EventBridge
  if (config.eventbridge?.length) {
    lines.push(``);
    lines.push(`  eventbridge: [`);
    for (const rule of config.eventbridge) {
      lines.push(`    ${formatObject(rule, 4)},`);
    }
    lines.push(`  ],`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

function formatObject(obj: any, indent: number): string {
  const pad = ' '.repeat(indent);
  const innerPad = ' '.repeat(indent + 2);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    if (obj.every(item => typeof item === 'string')) {
      return `[${obj.map(s => `'${s}'`).join(', ')}]`;
    }
    const items = obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        return `${innerPad}${formatObject(item, indent + 2)}`;
      }
      return `${innerPad}${formatValue(item)}`;
    });
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  const entries = Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '{}';

  // Short objects on one line
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
// Main import orchestrator
// ---------------------------------------------------------------------------

export async function importStack(
  stackName: string,
  profile: string,
  region: string = 'us-east-1',
  outputPath?: string
): Promise<string> {
  console.log(`\nForge: importing CloudFormation stack '${stackName}'\n`);
  console.log(`  Profile: ${profile}`);
  console.log(`  Region:  ${region}`);
  console.log('');

  // Authenticate
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

  const ctx: ImportContext = {
    stackName,
    profile,
    region,
    accountId,
    credentials,
    resources: [],
  };

  // List all resources in the stack
  console.log(`\n  Reading stack resources...`);
  ctx.resources = await listStackResources(ctx);
  console.log(`  Found ${ctx.resources.length} resources\n`);

  // Group by type for summary
  const typeCounts = new Map<string, number>();
  for (const r of ctx.resources) {
    typeCounts.set(r.ResourceType, (typeCounts.get(r.ResourceType) ?? 0) + 1);
  }
  console.log('  Resource types:');
  for (const [type, count] of [...typeCounts.entries()].sort()) {
    console.log(`    ${type}: ${count}`);
  }
  console.log('');

  // Derive app name from stack name
  // Simple: lowercase the stack name, don't try to split camelCase
  // (STRfish -> strfish, YeonCrm -> yeoncrm, VisibleWealth -> visiblewealth)
  const appName = stackName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

  console.log(`  Importing resources...\n`);

  // Import each resource type
  const config: ImportedConfig = {
    app: appName,
    profile,
    region,
  };

  config.vpc = await importVpc(ctx);
  config.rds = await importRds(ctx);
  config.cognito = await importCognito(ctx);
  config.lambda = await importLambdas(ctx);
  config.apiGateway = await importApiGateway(ctx);
  config.dynamodb = await importDynamoDb(ctx);
  config.s3 = await importS3(ctx);
  config.eventbridge = await importEventBridge(ctx);

  // Clean up empty arrays
  if (config.lambda?.length === 0) config.lambda = undefined;
  if (config.dynamodb?.length === 0) config.dynamodb = undefined;
  if (config.s3?.length === 0) config.s3 = undefined;
  if (config.eventbridge?.length === 0) config.eventbridge = undefined;

  // Generate config file
  console.log('\n  Generating forge config...\n');
  const configSource = generateConfigSource(config);

  // Write to file
  const outFile = outputPath ?? `${appName}.forge.config.ts`;
  const { writeFileSync } = await import('fs');
  writeFileSync(outFile, configSource, 'utf-8');

  console.log(`  Written to: ${outFile}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Review ${outFile} — verify all values look correct`);
  console.log(`    2. Run: forge plan --config ${outFile}`);
  console.log(`       This should show all resources as "unchanged"`);
  console.log(`    3. If plan looks clean, you can stop running cdk deploy`);
  console.log(`       The CDK stack stays in place — forge just adopts the resources`);
  console.log('');

  return outFile;
}
