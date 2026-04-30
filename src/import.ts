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
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { lambdaName, templatizeName } from './aws.js';

// Resolved at runtime so the generated config's import path always points to
// THIS Forge installation, not a hardcoded one. Generated configs work from
// any project directory without manual editing.
const FORGE_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'config.js');

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
  kms?: any[];
  secrets?: any[];
  pinpoint?: any[];
  managedPolicies?: any[];
  securityGroups?: any[];
  lambdaLayers?: any[];
  eventBuses?: any[];
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
        const config: any = {
          mode: 'instance' as const,
          engineVersion: instance.EngineVersion,
          dbName: instance.DBName,
          masterUsername: instance.MasterUsername,
          instanceClass: instance.DBInstanceClass,
          storage: instance.AllocatedStorage,
          deletionProtection: instance.DeletionProtection ?? false,
          proxy: proxies.length > 0,
        };
        // CDK-created instances don't follow Forge's default {app}-db naming.
        // Without an explicit clusterId override, describeRds would look for the
        // wrong ID and report the instance as missing — plan would then say CREATE,
        // and apply would try to provision a brand new database. Capture the actual ID.
        const expectedId = `${ctx.stackName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')}-db`;
        if (instanceId !== expectedId) {
          config.clusterId = instanceId;
        }
        return config;
      }
    } catch (err: any) {
      console.log(`  [rds] Warning: could not describe instance ${instanceId}: ${err.message}`);
    }
  }

  return undefined;
}

async function importCognito(ctx: ImportContext): Promise<any | undefined> {
  const poolResources = ctx.resources.filter(r => r.ResourceType === 'AWS::Cognito::UserPool');
  if (poolResources.length === 0) return undefined;

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

  // Iterate every pool. txdmv-rts has 4 (county/dealer/citizen/le); a previous version
  // of this importer took only pools[0] and silently dropped the other 3.
  const poolConfigs: any[] = [];
  for (const poolRes of poolResources) {
    const poolId = poolRes.PhysicalResourceId;
    console.log(`  [cognito] Found user pool: ${poolId}`);

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
        console.log(`    [cognito] Found client: ${cc?.ClientName} (${cc?.ClientId})`);
      }

      // Extract triggers. Use lambdaName() because Cognito sometimes stores
      // versioned ARNs (`...:function:name:42`); split-pop would return "42".
      const triggers: any = {};
      const lambdaConfig = pool?.LambdaConfig;
      if (lambdaConfig?.PreTokenGeneration) {
        triggers.preTokenGeneration = lambdaName(lambdaConfig.PreTokenGeneration);
        console.log(`    [cognito] PreTokenGeneration trigger: ${triggers.preTokenGeneration}`);
      }
      if (lambdaConfig?.PostConfirmation) {
        triggers.postConfirmation = lambdaName(lambdaConfig.PostConfirmation);
        console.log(`    [cognito] PostConfirmation trigger: ${triggers.postConfirmation}`);
      }
      if (lambdaConfig?.PreSignUp) {
        triggers.preSignUp = lambdaName(lambdaConfig.PreSignUp);
      }
      if (lambdaConfig?.CustomMessage) {
        triggers.customMessage = lambdaName(lambdaConfig.CustomMessage);
      }
      if (lambdaConfig?.CustomEmailSender?.LambdaArn) {
        triggers.customEmailSender = lambdaName(lambdaConfig.CustomEmailSender.LambdaArn);
        console.log(`    [cognito] CustomEmailSender trigger: ${triggers.customEmailSender}`);
      }
      if (lambdaConfig?.KMSKeyID) {
        triggers.customSenderKmsKey = lambdaConfig.KMSKeyID;
      }

      const poolConfig: any = {
        poolName: pool?.Name,
        emailSignup: pool?.UsernameAttributes?.includes('email') ?? true,
        clients,
      };

      // Cognito Hosted UI domain. The Domain field on a pool is the prefix string
      // (or the full custom domain). Capture it so applyCognito can verify on plan.
      if (pool?.Domain) {
        poolConfig.domainPrefix = pool.Domain;
        console.log(`    [cognito] Domain: ${pool.Domain}`);
      }

      // Password policy
      if (pool?.Policies?.PasswordPolicy) {
        const pp = pool.Policies.PasswordPolicy;
        poolConfig.passwordPolicy = {
          minLength: pp.MinimumLength,
          requireLowercase: pp.RequireLowercase,
          requireUppercase: pp.RequireUppercase,
          requireDigits: pp.RequireNumbers,
          requireSymbols: pp.RequireSymbols,
        };
      }

      // MFA
      if (pool?.MfaConfiguration && pool.MfaConfiguration !== 'OFF') {
        poolConfig.mfa = pool.MfaConfiguration;
      }

      // Custom attributes (filter out built-in standard attributes — those start with
      // lowercase letters, custom ones start with 'custom:' in the name).
      const customAttrs = (pool?.SchemaAttributes ?? []).filter(a =>
        a.Name?.startsWith('custom:') || (a.DeveloperOnlyAttribute === false && /^[A-Z_]/.test(a.Name?.[0] ?? ''))
      );
      // Cognito returns custom attrs with 'custom:' prefix in the Name. Strip for config —
      // applyCognito's AddCustomAttributesCommand expects bare names.
      const captured = customAttrs.map(a => ({
        name: a.Name!.replace(/^custom:/, ''),
        type: a.AttributeDataType,
        mutable: a.Mutable,
        required: a.Required,
      }));
      if (captured.length > 0) {
        poolConfig.customAttributes = captured;
        console.log(`    [cognito] Custom attributes: ${captured.length}`);
      }

      // Account recovery
      const recovery = pool?.AccountRecoverySetting?.RecoveryMechanisms?.[0]?.Name;
      if (recovery === 'verified_email') poolConfig.accountRecovery = 'EMAIL_ONLY';
      else if (recovery === 'verified_phone_number') poolConfig.accountRecovery = 'PHONE_ONLY';

      if (Object.keys(triggers).length > 0) {
        poolConfig.triggers = triggers;
      }

      if (pool?.EmailConfiguration?.SourceArn) {
        poolConfig.emailSender = pool.EmailConfiguration.EmailSendingAccount === 'DEVELOPER'
          ? pool.EmailConfiguration.From ?? pool.EmailConfiguration.SourceArn
          : undefined;
      }

      poolConfigs.push(poolConfig);
    } catch (err: any) {
      console.log(`  [cognito] Warning: could not describe pool ${poolId}: ${err.message}`);
    }
  }

  if (poolConfigs.length === 0) return undefined;
  // Single pool → return as object (matches CognitoConfig). Multiple → return as array
  // (matches CognitoConfig[]). The defineConfig type accepts either form.
  return poolConfigs.length === 1 ? poolConfigs[0] : poolConfigs;
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
        // Capture the existing role ARN. Without this, applyLambda would create a
        // fresh role and silently swap the function over to it on apply.
        roleArn: cfg.Role,
      };

      // Check if in VPC
      if (cfg.VpcConfig?.SubnetIds?.length) {
        lambdaConfig.vpc = true;
      }

      // Capture both managed AND inline policies on the role.
      // Managed: ARNs only — applyLambda attaches them additively.
      // Inline: full statements per named policy — applyLambda PutRolePolicy's by name,
      // letting Forge take ownership of CDK-named policies (e.g. 'EmberLambdaRoleDefaultPolicyXYZ').
      // Without inline capture, those policies would stay in CFN ownership forever and
      // CFN stack retirement would be impossible.
      if (cfg.Role) {
        const roleName = cfg.Role.split('/').pop();
        if (roleName) {
          try {
            const {
              IAMClient: IamClass,
              ListAttachedRolePoliciesCommand: ListAttachedPoliciesCmd,
              ListRolePoliciesCommand: ListInlineCmd,
              GetRolePolicyCommand: GetInlineCmd,
            } = await import('@aws-sdk/client-iam');
            const iam = new IamClass({ region: ctx.region, credentials: ctx.credentials });

            const managedRes = await iam.send(new ListAttachedPoliciesCmd({ RoleName: roleName }));
            const arns = (managedRes.AttachedPolicies ?? [])
              .map((p: any) => p.PolicyArn)
              .filter(Boolean) as string[];
            if (arns.length > 0) lambdaConfig.policies = arns;

            const inlineRes = await iam.send(new ListInlineCmd({ RoleName: roleName }));
            const inlineNames = inlineRes.PolicyNames ?? [];
            const inlinePolicies: any[] = [];
            for (const policyName of inlineNames) {
              try {
                const policyRes = await iam.send(new GetInlineCmd({ RoleName: roleName, PolicyName: policyName }));
                // PolicyDocument comes back URL-encoded JSON.
                const docStr = decodeURIComponent(policyRes.PolicyDocument ?? '{}');
                const doc = JSON.parse(docStr);
                const stmts = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
                inlinePolicies.push({
                  name: policyName,
                  statements: stmts.map((s: any) => {
                    const out: any = {
                      effect: s.Effect,
                      actions: Array.isArray(s.Action) ? s.Action : [s.Action],
                      resources: Array.isArray(s.Resource) ? s.Resource : [s.Resource],
                    };
                    if (s.Sid) out.sid = s.Sid;
                    if (s.Condition) out.conditions = s.Condition;
                    return out;
                  }),
                });
              } catch (err: any) {
                console.log(`  [lambda] Warning: could not get inline policy ${policyName} on ${roleName}: ${err.message}`);
              }
            }
            if (inlinePolicies.length > 0) lambdaConfig.inlinePolicies = inlinePolicies;
          } catch (err: any) {
            console.log(`  [lambda] Warning: could not list policies for role ${roleName}: ${err.message}`);
          }
        }
      }

      // Capture Function URL config if one exists. Lets Forge own URL settings
      // (auth type, CORS) instead of relying on CDK to keep them in sync.
      try {
        const { GetFunctionUrlConfigCommand: GetUrlCmd } = await import('@aws-sdk/client-lambda');
        const urlRes = await lam.send(new GetUrlCmd({ FunctionName: functionName }));
        const fu: any = { authType: urlRes.AuthType };
        if (urlRes.Cors) {
          const cors: any = {};
          if (urlRes.Cors.AllowOrigins?.length) cors.allowOrigins = urlRes.Cors.AllowOrigins;
          if (urlRes.Cors.AllowMethods?.length) cors.allowMethods = urlRes.Cors.AllowMethods;
          if (urlRes.Cors.AllowHeaders?.length) cors.allowHeaders = urlRes.Cors.AllowHeaders;
          if (urlRes.Cors.AllowCredentials) cors.allowCredentials = urlRes.Cors.AllowCredentials;
          if (urlRes.Cors.MaxAge) cors.maxAge = urlRes.Cors.MaxAge;
          if (urlRes.Cors.ExposeHeaders?.length) cors.exposeHeaders = urlRes.Cors.ExposeHeaders;
          if (Object.keys(cors).length > 0) fu.cors = cors;
        }
        lambdaConfig.functionUrl = fu;
        console.log(`    [lambda] Function URL: ${urlRes.FunctionUrl}`);
      } catch (err: any) {
        // No URL configured for this function — that's normal.
        if (err.name !== 'ResourceNotFoundException') {
          console.log(`  [lambda] Warning: could not check Function URL for ${functionName}: ${err.message}`);
        }
      }

      // Capture event source mappings (SQS, Kinesis, DynamoDB Streams → this Lambda).
      try {
        const { ListEventSourceMappingsCommand: ListEsmCmd } = await import('@aws-sdk/client-lambda');
        const esmRes = await lam.send(new ListEsmCmd({ FunctionName: functionName }));
        const sources = (esmRes.EventSourceMappings ?? [])
          .filter(m => m.State === 'Enabled' || m.State === 'Creating')
          .map(m => {
            const src: any = { source: m.EventSourceArn };
            if (m.BatchSize !== undefined) src.batchSize = m.BatchSize;
            if (m.MaximumBatchingWindowInSeconds) src.maximumBatchingWindowInSeconds = m.MaximumBatchingWindowInSeconds;
            if (m.FunctionResponseTypes?.includes('ReportBatchItemFailures')) {
              src.reportBatchItemFailures = true;
            }
            return src;
          });
        if (sources.length > 0) {
          lambdaConfig.eventSources = sources;
          console.log(`    [lambda] Event sources: ${sources.length} (${sources.map((s: any) => s.source.split(':').pop()).join(', ')})`);
        }
      } catch (err: any) {
        console.log(`  [lambda] Warning: could not list event sources for ${functionName}: ${err.message}`);
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
        // Skip secret-pattern env vars entirely. applyLambda's env-merge logic preserves
        // them from the live function's current state, so omitting from config keeps
        // secrets out of version control while staying safe on apply. Writing
        // "REDACTED — ..." as a literal value would silently overwrite production
        // secrets on the next apply (this happened on yeon-crm 2026-04-29).
        const isSecret = secretPatterns.some(p => p.test(key));
        if (isSecret) continue;
        filteredEnv[key] = value;
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

    // Separate public vs authenticated routes. Capture both so the imported config
    // accurately represents the live API. catchAll mode means {proxy+} routes are
    // explicit; only treat as catch-all if the catch-all routes are present AND we
    // don't have other authenticated routes outside it (otherwise it's mixed mode).
    const publicRoutes: string[] = [];
    const authenticatedRoutes: string[] = [];
    let hasCatchAll = false;

    for (const route of routes) {
      if (route.RouteKey === '$default') continue;
      if (route.AuthorizationType === 'NONE') {
        publicRoutes.push(route.RouteKey!);
      } else {
        authenticatedRoutes.push(route.RouteKey!);
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
      // Filter out catch-all routes from authenticatedRoutes — those are managed by the
      // catchAll: true flag in apply, not enumerated explicitly. Keeps config tidy.
      authenticatedRoutes: hasCatchAll
        ? (authenticatedRoutes.filter(r => !r.includes('{proxy+}')).length > 0
            ? authenticatedRoutes.filter(r => !r.includes('{proxy+}'))
            : undefined)
        : (authenticatedRoutes.length > 0 ? authenticatedRoutes : undefined),
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

    // Replace account ID and region with placeholders for portability.
    // templatizeName anchors on non-digit/non-alpha boundaries so a
    // coincidentally-matching digit run inside a longer ID isn't corrupted.
    const templateName = templatizeName(bucketName, ctx);

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

    // Bucket policy (resource-based) — captured as parsed JSON object.
    try {
      const { GetBucketPolicyCommand: GetPolicyCmd } = await import('@aws-sdk/client-s3');
      const polRes = await s3.send(new GetPolicyCmd({ Bucket: bucketName }));
      if (polRes.Policy) {
        config.policy = JSON.parse(polRes.Policy);
        console.log(`  [s3] ${bucketName}: captured bucket policy`);
      }
    } catch (err: any) {
      // No policy is normal for many buckets.
      if (err.name !== 'NoSuchBucketPolicy') {
        console.log(`  [s3] Warning: could not get policy for ${bucketName}: ${err.message}`);
      }
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
      // Use lambdaName so versioned/aliased ARNs collapse to the bare name
      // instead of the version suffix.
      const targetLambda = lambdaName(target?.Arn);

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

async function importLambdaLayers(ctx: ImportContext): Promise<any[]> {
  const layerResources = ctx.resources.filter(r => r.ResourceType === 'AWS::Lambda::LayerVersion');
  if (layerResources.length === 0) return [];

  const { LambdaClient, GetLayerVersionByArnCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];
  // Track unique layer names — a stack might have multiple versions of the same layer.
  const seen = new Set<string>();
  for (const lr of layerResources) {
    const arn = lr.PhysicalResourceId;
    try {
      const res = await lambda.send(new GetLayerVersionByArnCommand({ Arn: arn }));
      const layerName = res.LayerArn?.split(':').pop();
      if (!layerName || seen.has(layerName)) continue;
      seen.add(layerName);
      const config: any = { name: layerName };
      if (res.Description) config.description = res.Description;
      if (res.CompatibleRuntimes?.length) config.compatibleRuntimes = res.CompatibleRuntimes;
      if (res.CompatibleArchitectures?.length) config.compatibleArchitectures = res.CompatibleArchitectures;
      configs.push(config);
      console.log(`  [lambda-layer] Found: ${layerName}`);
    } catch (err: any) {
      console.log(`  [lambda-layer] Warning: could not describe ${arn}: ${err.message}`);
    }
  }
  return configs;
}

async function importEventBuses(ctx: ImportContext): Promise<any[]> {
  const busResources = ctx.resources.filter(r => r.ResourceType === 'AWS::Events::EventBus');
  if (busResources.length === 0) return [];

  const configs: any[] = [];
  for (const br of busResources) {
    const name = br.PhysicalResourceId;
    if (!name || name === 'default') continue;
    configs.push({ name });
    console.log(`  [event-bus] Found: ${name}`);
  }
  return configs;
}

async function importSecurityGroups(ctx: ImportContext): Promise<any[]> {
  const sgResources = ctx.resources.filter(r => r.ResourceType === 'AWS::EC2::SecurityGroup');
  if (sgResources.length === 0) return [];

  const { EC2Client, DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2');
  const ec2 = new EC2Client({ region: ctx.region, credentials: ctx.credentials });

  // Fetch all in one call by group ID for efficiency.
  const groupIds = sgResources.map(r => r.PhysicalResourceId).filter(Boolean);
  let groups: any[] = [];
  try {
    const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: groupIds }));
    groups = res.SecurityGroups ?? [];
  } catch (err: any) {
    console.log(`  [security-group] Warning: could not describe SGs: ${err.message}`);
    return [];
  }

  // Build a GroupId → GroupName map so we can convert UserIdGroupPairs into
  // friendly sourceSg references in the imported config.
  const idToName = new Map<string, string>();
  for (const sg of groups) {
    if (sg.GroupId && sg.GroupName) idToName.set(sg.GroupId, sg.GroupName);
  }

  const configs: any[] = [];
  for (const sg of groups) {
    if (!sg.GroupName) continue;

    const buildRules = (perms: any[]): any[] => {
      const rules: any[] = [];
      for (const p of perms ?? []) {
        const protocol = p.IpProtocol === '-1' ? '-1' : p.IpProtocol;
        const base: any = { protocol };
        if (protocol !== '-1') {
          base.fromPort = p.FromPort;
          base.toPort = p.ToPort;
        }
        // CIDR-based rules
        for (const cidr of p.IpRanges ?? []) {
          rules.push({ ...base, cidrIp: cidr.CidrIp, description: cidr.Description });
        }
        // SG-source rules → use friendly name if known (intra-stack), else GroupId
        for (const pair of p.UserIdGroupPairs ?? []) {
          rules.push({
            ...base,
            sourceSg: idToName.get(pair.GroupId) ?? pair.GroupId,
            description: pair.Description,
          });
        }
      }
      return rules;
    };

    const config: any = {
      name: sg.GroupName,
      description: sg.Description ?? '',
      vpcId: sg.VpcId,
      ingress: buildRules(sg.IpPermissions),
      egress: buildRules(sg.IpPermissionsEgress),
    };
    // Strip empty arrays so the config is tidy.
    if (config.ingress.length === 0) delete config.ingress;
    if (config.egress.length === 0) delete config.egress;

    configs.push(config);
    console.log(`  [security-group] Found: ${sg.GroupName}`);
  }

  return configs;
}

async function importManagedPolicies(ctx: ImportContext): Promise<any[]> {
  const policyResources = ctx.resources.filter(r => r.ResourceType === 'AWS::IAM::ManagedPolicy');
  if (policyResources.length === 0) return [];

  const { IAMClient, GetPolicyCommand, GetPolicyVersionCommand } = await import('@aws-sdk/client-iam');
  const iam = new IAMClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];
  for (const pr of policyResources) {
    const arn = pr.PhysicalResourceId;
    try {
      const policyRes = await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
      const meta = policyRes.Policy;
      if (!meta) continue;

      // Get the default version's document.
      let document: any = { Version: '2012-10-17', Statement: [] };
      if (meta.DefaultVersionId) {
        const verRes = await iam.send(new GetPolicyVersionCommand({
          PolicyArn: arn,
          VersionId: meta.DefaultVersionId,
        }));
        if (verRes.PolicyVersion?.Document) {
          document = JSON.parse(decodeURIComponent(verRes.PolicyVersion.Document));
        }
      }

      const config: any = {
        name: meta.PolicyName ?? arn.split('/').pop(),
        document,
      };
      if (meta.Description) config.description = meta.Description;
      configs.push(config);
      console.log(`  [managed-policy] Found: ${meta.PolicyName}`);
    } catch (err: any) {
      console.log(`  [managed-policy] Warning: could not describe ${arn}: ${err.message}`);
    }
  }

  return configs;
}

async function importPinpoint(ctx: ImportContext): Promise<any[]> {
  const ppResources = ctx.resources.filter(r => r.ResourceType === 'AWS::Pinpoint::App');
  if (ppResources.length === 0) return [];

  const { PinpointClient, GetAppCommand } = await import('@aws-sdk/client-pinpoint');
  const pp = new PinpointClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];
  for (const pr of ppResources) {
    const appId = pr.PhysicalResourceId;
    try {
      const res = await pp.send(new GetAppCommand({ ApplicationId: appId }));
      const name = res.ApplicationResponse?.Name;
      if (name) {
        configs.push({ name });
        console.log(`  [pinpoint] Found app: ${name}`);
      }
    } catch (err: any) {
      console.log(`  [pinpoint] Warning: could not describe app ${appId}: ${err.message}`);
    }
  }
  return configs;
}

async function importSecrets(ctx: ImportContext): Promise<any[]> {
  const secretResources = ctx.resources.filter(r => r.ResourceType === 'AWS::SecretsManager::Secret');
  if (secretResources.length === 0) return [];

  const { SecretsManagerClient, DescribeSecretCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: ctx.region, credentials: ctx.credentials });

  const configs: any[] = [];
  for (const sr of secretResources) {
    const secretArn = sr.PhysicalResourceId;
    try {
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: secretArn }));
      // Use the secret NAME (not ARN) as the stable identifier — names are user-defined
      // and survive re-creation; ARNs include account+region+random suffix.
      const config: any = {
        name: desc.Name ?? secretArn,
      };
      if (desc.Description) config.description = desc.Description;
      configs.push(config);
      console.log(`  [secrets-manager] Found: ${desc.Name}`);
    } catch (err: any) {
      console.log(`  [secrets-manager] Warning: could not describe ${secretArn}: ${err.message}`);
    }
  }

  return configs;
}

async function importKms(ctx: ImportContext): Promise<any[]> {
  const keyResources = ctx.resources.filter(r => r.ResourceType === 'AWS::KMS::Key');
  if (keyResources.length === 0) return [];

  const { KMSClient, DescribeKeyCommand, ListAliasesCommand, GetKeyRotationStatusCommand } =
    await import('@aws-sdk/client-kms');
  const kms = new KMSClient({ region: ctx.region, credentials: ctx.credentials });

  // Build keyId → alias lookup so each key gets its alias as the stable identifier.
  const aliasByKey = new Map<string, string>();
  let nextMarker: string | undefined;
  do {
    const aliasRes = await kms.send(new ListAliasesCommand({ Marker: nextMarker, Limit: 100 }));
    for (const a of aliasRes.Aliases ?? []) {
      // Skip AWS-managed aliases (alias/aws/*) — we only care about user/CDK keys here.
      if (a.AliasName?.startsWith('alias/aws/')) continue;
      if (a.TargetKeyId && a.AliasName) {
        aliasByKey.set(a.TargetKeyId, a.AliasName);
      }
    }
    nextMarker = aliasRes.NextMarker;
  } while (nextMarker);

  const configs: any[] = [];
  for (const kr of keyResources) {
    const keyId = kr.PhysicalResourceId;
    try {
      const desc = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
      const meta = desc.KeyMetadata;
      if (!meta || meta.KeyState === 'PendingDeletion') continue;

      let rotationEnabled = false;
      try {
        const rot = await kms.send(new GetKeyRotationStatusCommand({ KeyId: keyId }));
        rotationEnabled = rot.KeyRotationEnabled ?? false;
      } catch {
        // Some key types don't support rotation; treat as disabled.
      }

      const aliasName = aliasByKey.get(keyId);
      // Strip the 'alias/' prefix for the config — KmsKeyConfig.alias expects bare name.
      const aliasBare = aliasName ? aliasName.replace(/^alias\//, '') : undefined;

      const config: any = {
        // No alias on adopted key → fall back to keyId for lookup.
        alias: aliasBare ?? `${kr.LogicalResourceId.toLowerCase()}-key`,
        keyId,
        description: meta.Description,
        enableKeyRotation: rotationEnabled,
      };

      configs.push(config);
      console.log(`  [kms] Found key: ${aliasBare ?? keyId} (rotation=${rotationEnabled})`);
    } catch (err: any) {
      console.log(`  [kms] Warning: could not describe key ${keyId}: ${err.message}`);
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
  lines.push(`import { defineConfig } from '${FORGE_CONFIG_PATH}';`);
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

  // KMS
  if (config.kms?.length) {
    lines.push(``);
    lines.push(`  kms: [`);
    for (const key of config.kms) {
      lines.push(`    ${formatObject(key, 4)},`);
    }
    lines.push(`  ],`);
  }

  // SecretsManager (metadata only — values stay in AWS)
  if (config.secrets?.length) {
    lines.push(``);
    lines.push(`  secrets: [`);
    for (const secret of config.secrets) {
      lines.push(`    ${formatObject(secret, 4)},`);
    }
    lines.push(`  ],`);
  }

  // Pinpoint apps
  if (config.pinpoint?.length) {
    lines.push(``);
    lines.push(`  pinpoint: [`);
    for (const pp of config.pinpoint) {
      lines.push(`    ${formatObject(pp, 4)},`);
    }
    lines.push(`  ],`);
  }

  // IAM Managed Policies (standalone — distinct from per-Lambda inline policies)
  if (config.managedPolicies?.length) {
    lines.push(``);
    lines.push(`  managedPolicies: [`);
    for (const mp of config.managedPolicies) {
      lines.push(`    ${formatObject(mp, 4)},`);
    }
    lines.push(`  ],`);
  }

  // Standalone Security Groups
  if (config.securityGroups?.length) {
    lines.push(``);
    lines.push(`  securityGroups: [`);
    for (const sg of config.securityGroups) {
      lines.push(`    ${formatObject(sg, 4)},`);
    }
    lines.push(`  ],`);
  }

  // Lambda Layers (referenced by Lambda config.layers ARNs)
  if (config.lambdaLayers?.length) {
    lines.push(``);
    lines.push(`  lambdaLayers: [`);
    for (const layer of config.lambdaLayers) {
      lines.push(`    ${formatObject(layer, 4)},`);
    }
    lines.push(`  ],`);
  }

  // Custom EventBuses (referenced by EventBridge rules)
  if (config.eventBuses?.length) {
    lines.push(``);
    lines.push(`  eventBuses: [`);
    for (const bus of config.eventBuses) {
      lines.push(`    ${formatObject(bus, 4)},`);
    }
    lines.push(`  ],`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

/**
 * Quote object keys that aren't valid JS identifiers (e.g. 'detail-type' in
 * EventBridge event patterns) so the generated config parses cleanly.
 */
function formatKey(key: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
  return `'${key.replace(/'/g, "\\'")}'`;
}

/**
 * Maximum column width for inline object/array literals before formatObject
 * breaks them across multiple lines. Matches the project's prettier-like
 * default; overflowing this much is more readable as a multi-line block.
 */
const INLINE_WIDTH = 80;

function formatObject(obj: any, indent: number): string {
  const pad = ' '.repeat(indent);
  const innerPad = ' '.repeat(indent + 2);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    // String-only arrays: try inline first; multi-line if the inline form
    // would overflow INLINE_WIDTH at this indent depth.
    if (obj.every(item => typeof item === 'string')) {
      const inline = `[${obj.map(s => formatValue(s)).join(', ')}]`;
      if (indent + inline.length <= INLINE_WIDTH) return inline;
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

  // Inline an object only when:
  //   1. None of its values are nested objects/arrays
  //   2. The fully-rendered inline form fits in INLINE_WIDTH columns at
  //      the current indent depth
  // This replaces the earlier `entries.length <= 2` rule which was
  // arbitrary: 3-key objects of short strings produced unnecessary
  // multi-line output, and 2-key objects with long values overflowed.
  const allPrimitive = entries.every(([, v]) => typeof v !== 'object' || v === null);
  if (allPrimitive) {
    const pairs = entries.map(([k, v]) => `${formatKey(k)}: ${formatValue(v)}`);
    const inline = `{ ${pairs.join(', ')} }`;
    if (indent + inline.length <= INLINE_WIDTH) return inline;
  }

  const lines = entries.map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      return `${innerPad}${formatKey(key)}: ${formatObject(value, indent + 2)}`;
    }
    return `${innerPad}${formatKey(key)}: ${formatValue(value)}`;
  });

  return `{\n${lines.join(',\n')},\n${pad}}`;
}

function formatValue(val: unknown): string {
  if (typeof val === 'string') {
    // JSON.stringify emits a syntactically-valid TS string literal (double
    // quotes, escapes embedded quotes / backslashes / control chars
    // correctly). The earlier `'${val}'` form broke when the value contained
    // a single quote (e.g., a description like "Citizen's portal") because
    // the apostrophe terminated the literal mid-string and produced
    // invalid TypeScript.
    return JSON.stringify(val);
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  return String(val);
}

// ---------------------------------------------------------------------------
// Main import orchestrator
// ---------------------------------------------------------------------------

export async function importStack(
  stackNames: string | string[],
  profile: string,
  region: string = 'us-east-1',
  outputPath?: string
): Promise<string> {
  // Accept single name or array — multi-stack lets apps split across CFN stacks
  // (tanaiger has 8, ember has 5+) get merged into one forge.config.ts.
  const stacks = Array.isArray(stackNames) ? stackNames : [stackNames];
  if (stacks.length === 0) throw new Error('At least one stack name is required.');

  const stackLabel = stacks.length === 1 ? `stack '${stacks[0]}'` : `${stacks.length} stacks (${stacks.join(', ')})`;
  console.log(`\nForge: importing CloudFormation ${stackLabel}\n`);
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
    // The first stack's name is used as the canonical "stack name" for things like
    // RDS clusterId default-derivation. For multi-stack imports, the first stack
    // should typically be the one closest to the app's identity (e.g., Tanaiger-Api
    // when importing Tanaiger-* together).
    stackName: stacks[0],
    profile,
    region,
    accountId,
    credentials,
    resources: [],
  };

  // List all resources from each stack and merge. Resources are tagged with their
  // origin stack name only via the LogicalResourceId pattern; the importers don't
  // care about which stack a resource came from — they only care about ResourceType.
  for (const stack of stacks) {
    console.log(`\n  Reading resources from ${stack}...`);
    ctx.stackName = stack;
    const stackResources = await listStackResources(ctx);
    ctx.resources.push(...stackResources);
    console.log(`    Found ${stackResources.length} resources`);
  }
  // Restore the canonical stackName for downstream importers (they use it for
  // default-naming heuristics, e.g. ${stackName}-aurora).
  ctx.stackName = stacks[0];
  console.log(`\n  Total resources across ${stacks.length} stack${stacks.length > 1 ? 's' : ''}: ${ctx.resources.length}\n`);

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

  // Derive app name from the first stack name. For multi-stack, this picks up the
  // first stack — user can edit the generated config's `app` field if needed.
  const appName = stacks[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

  console.log(`  Importing resources...\n`);

  // Import each resource type
  const config: ImportedConfig = {
    app: appName,
    profile,
    region,
  };

  config.vpc = await importVpc(ctx);
  config.rds = await importRds(ctx);
  config.kms = await importKms(ctx);
  config.secrets = await importSecrets(ctx);
  config.pinpoint = await importPinpoint(ctx);
  config.managedPolicies = await importManagedPolicies(ctx);
  config.securityGroups = await importSecurityGroups(ctx);
  config.lambdaLayers = await importLambdaLayers(ctx);
  config.eventBuses = await importEventBuses(ctx);
  config.cognito = await importCognito(ctx);
  config.lambda = await importLambdas(ctx);
  config.apiGateway = await importApiGateway(ctx);
  config.dynamodb = await importDynamoDb(ctx);
  config.s3 = await importS3(ctx);
  config.eventbridge = await importEventBridge(ctx);

  // Strip empty top-level arrays so the generated config stays tidy.
  // Walks every key generically rather than naming individual fields, so
  // new resource types that get added to the import surface don't pollute
  // output with `kms: []`-style noise.
  for (const key of Object.keys(config) as Array<keyof typeof config>) {
    const value = config[key];
    if (Array.isArray(value) && value.length === 0) {
      delete config[key];
    }
  }

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
