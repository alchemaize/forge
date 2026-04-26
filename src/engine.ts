/**
 * Forge engine — orchestrates plan/apply/status across all resource modules.
 *
 * Deployment phases (respects dependency order):
 * 1. VPC (everything else may depend on it)
 * 2. RDS/Aurora (needs VPC)
 * 3. IAM roles, S3, DynamoDB, ECR, SNS, SSM (independent)
 * 4. Cognito (independent but Lambda triggers reference it)
 * 5. Lambda (needs VPC, IAM, env vars from RDS/Cognito)
 * 6. API Gateway (needs Lambda, Cognito)
 * 7. ECS Express (needs ECR)
 * 8. EventBridge (needs Lambda)
 */

import type { ForgeConfig } from './config.js';
import { initAwsContext, type AwsContext } from './aws.js';
import { createPlan, displayPlan, type Plan } from './diff.js';
import * as vpc from './resources/vpc.js';
import * as rds from './resources/rds.js';
import * as cognito from './resources/cognito.js';
import * as lambda from './resources/lambda.js';
import * as apiGateway from './resources/api-gateway.js';
import * as dynamodb from './resources/dynamodb.js';
import * as s3 from './resources/s3.js';
import * as ecsExpress from './resources/ecs-express.js';
import * as cloudfront from './resources/cloudfront.js';
import * as elasticache from './resources/elasticache.js';
import * as stepFunctions from './resources/step-functions.js';
import * as sqs from './resources/sqs.js';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function plan(config: ForgeConfig): Promise<Plan> {
  const ctx = await initAwsContext(config);
  const p = createPlan();

  console.log(`\nForge: planning ${config.app} (${ctx.accountId} / ${ctx.region})\n`);

  // Phase 1: VPC
  if (config.vpc) {
    await vpc.planVpc(ctx, config.vpc, config.app, p);
  }

  // Phase 2: RDS
  if (config.rds) {
    await rds.planRds(ctx, config.rds, config.app, p);
  }

  // Phase 3: Independent resources
  for (const tableConfig of config.dynamodb ?? []) {
    await dynamodb.planDynamoTable(ctx, tableConfig, config.app, p);
  }
  for (const bucketConfig of config.s3 ?? []) {
    await s3.planS3Bucket(ctx, bucketConfig, config.app, p);
  }
  for (const ecrConfig of config.ecr ?? []) {
    await ecsExpress.planEcr(ctx, ecrConfig, config.app, p);
  }

  // ElastiCache
  if (config.elasticache) {
    await elasticache.planElastiCache(ctx, config.elasticache, config.app, p);
  }

  // SQS
  for (const sqsConfig of config.sqs ?? []) {
    await sqs.planSqs(ctx, sqsConfig, config.app, p);
  }

  // CloudFront
  for (const cfConfig of config.cloudfront ?? []) {
    await cloudfront.planCloudFront(ctx, cfConfig, config.app, p);
  }

  // Step Functions
  for (const sfConfig of config.stepFunctions ?? []) {
    await stepFunctions.planStepFunction(ctx, sfConfig, config.app, p);
  }

  // Phase 4: Cognito
  const cognitoConfigs = config.cognito
    ? (Array.isArray(config.cognito) ? config.cognito : [config.cognito])
    : [];
  for (const cognitoConfig of cognitoConfigs) {
    await cognito.planCognito(ctx, cognitoConfig, config.app, p);
  }

  // Phase 5: Lambda
  for (const lambdaConfig of config.lambda ?? []) {
    await lambda.planLambda(ctx, lambdaConfig, config.app, p);
  }

  // Phase 6: API Gateway
  if (config.apiGateway) {
    await apiGateway.planApiGateway(ctx, config.apiGateway, config.app, p);
  }

  // Phase 7: ECS Express
  for (const ecsConfig of config.ecsExpress ?? []) {
    await ecsExpress.planEcsExpress(ctx, ecsConfig, config.app, p);
  }

  displayPlan(p);
  return p;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function apply(config: ForgeConfig): Promise<void> {
  const ctx = await initAwsContext(config);

  console.log(`\nForge: applying ${config.app} (${ctx.accountId} / ${ctx.region})\n`);

  // Phase 1: VPC
  let vpcState: vpc.VpcState | undefined;
  if (config.vpc) {
    vpcState = await vpc.applyVpc(ctx, config.vpc, config.app);
    console.log('');
  }

  // Phase 2: RDS
  let rdsState: rds.RdsState | undefined;
  if (config.rds) {
    if (!vpcState) throw new Error('RDS requires VPC config');
    rdsState = await rds.applyRds(ctx, config.rds, config.app, vpcState);
    console.log('');
  }

  // Phase 3: Independent resources
  const dynamoStates: dynamodb.DynamoTableState[] = [];
  for (const tableConfig of config.dynamodb ?? []) {
    dynamoStates.push(await dynamodb.applyDynamoTable(ctx, tableConfig, config.app));
  }
  if (dynamoStates.length) console.log('');

  const s3States: s3.S3BucketState[] = [];
  for (const bucketConfig of config.s3 ?? []) {
    s3States.push(await s3.applyS3Bucket(ctx, bucketConfig, config.app));
  }
  if (s3States.length) console.log('');

  const ecrStates: ecsExpress.EcrState[] = [];
  for (const ecrConfig of config.ecr ?? []) {
    ecrStates.push(await ecsExpress.applyEcr(ctx, ecrConfig, config.app));
  }
  if (ecrStates.length) console.log('');

  // Phase 4: Cognito
  const cognitoConfigs = config.cognito
    ? (Array.isArray(config.cognito) ? config.cognito : [config.cognito])
    : [];
  const cognitoStates: cognito.CognitoState[] = [];
  for (const cognitoConfig of cognitoConfigs) {
    const state = await cognito.applyCognito(ctx, cognitoConfig, config.app);
    if (state) cognitoStates.push(state);
  }
  const cognitoState = cognitoStates[0]; // Primary pool for Lambda env auto-population
  if (cognitoStates.length) console.log('');

  // Phase 5: Lambda
  const lambdaStates: lambda.LambdaState[] = [];
  for (const lambdaConfig of config.lambda ?? []) {
    // Auto-populate env vars from other resources
    const env = { ...lambdaConfig.env };
    if (cognitoState) {
      env.COGNITO_USER_POOL_ID ??= cognitoState.userPoolId;
      env.COGNITO_CLIENT_ID ??= cognitoState.clients[0]?.clientId ?? '';
    }
    if (rdsState) {
      const dbHost = rdsState.proxyEndpoint ?? rdsState.clusterEndpoint ?? rdsState.instanceEndpoint ?? '';
      env.DB_HOST ??= dbHost;
      env.DB_PORT ??= String(rdsState.port);
      env.DB_NAME ??= rdsState.dbName;
    }
    env.AWS_REGION ??= ctx.region;
    env.NODE_ENV ??= 'production';

    const configWithEnv = { ...lambdaConfig, env };
    lambdaStates.push(await lambda.applyLambda(ctx, configWithEnv, config.app, vpcState));
  }
  if (lambdaStates.length) console.log('');

  // Phase 6: API Gateway
  let apiGwState: apiGateway.ApiGatewayState | undefined;
  if (config.apiGateway && lambdaStates.length > 0) {
    apiGwState = await apiGateway.applyApiGateway(
      ctx,
      config.apiGateway,
      config.app,
      lambdaStates[0],
      cognitoState
    );
    console.log('');
  }

  // Phase 7: ECS Express
  for (const ecsConfig of config.ecsExpress ?? []) {
    const ecrState = ecrStates.find(e => e.repoName === (ecsConfig.ecrRepo ?? ecsConfig.name));
    await ecsExpress.applyEcsExpress(ctx, ecsConfig, config.app, ecrState);
  }

  // Phase 8: CloudFront
  for (const cfConfig of config.cloudfront ?? []) {
    await cloudfront.applyCloudFront(ctx, cfConfig, config.app);
  }

  // Phase 9: ElastiCache
  if (config.elasticache) {
    await elasticache.applyElastiCache(ctx, config.elasticache, config.app);
  }

  // Phase 10: Step Functions
  for (const sfConfig of config.stepFunctions ?? []) {
    await stepFunctions.applyStepFunction(ctx, sfConfig, config.app);
  }

  // Phase 11: SQS
  for (const sqsConfig of config.sqs ?? []) {
    await sqs.applySqs(ctx, sqsConfig, config.app);
  }

  // Summary
  console.log('');
  console.log('═══ Forge Apply Complete ═══');
  console.log('');
  console.log('Resource Summary:');
  if (vpcState) console.log(`  VPC:            ${vpcState.vpcId}`);
  if (rdsState) {
    const endpoint = rdsState.proxyEndpoint ?? rdsState.clusterEndpoint ?? rdsState.instanceEndpoint;
    console.log(`  Database:       ${endpoint}:${rdsState.port}/${rdsState.dbName}`);
    if (rdsState.proxyEndpoint) console.log(`  RDS Proxy:      ${rdsState.proxyEndpoint}`);
    if (rdsState.secretArn) console.log(`  DB Secret:      ${rdsState.secretArn}`);
  }
  if (cognitoStates.length) {
    for (const cs of cognitoStates) {
      console.log(`  Cognito Pool:   ${cs.userPoolId}`);
      for (const c of cs.clients) {
        console.log(`  Cognito Client: ${c.clientId} (${c.clientName})`);
      }
    }
  }
  for (const ls of lambdaStates) {
    console.log(`  Lambda:         ${ls.functionName} (${ls.functionArn})`);
  }
  if (apiGwState) {
    console.log(`  API Gateway:    ${apiGwState.apiEndpoint} (${apiGwState.apiId})`);
  }
  for (const ds of dynamoStates) {
    console.log(`  DynamoDB:       ${ds.tableName}`);
  }
  for (const ss of s3States) {
    console.log(`  S3:             ${ss.bucketName}`);
  }
  for (const es of ecrStates) {
    console.log(`  ECR:            ${es.repoUri}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function status(config: ForgeConfig): Promise<void> {
  const ctx = await initAwsContext(config);

  console.log(`\nForge: status for ${config.app} (${ctx.accountId} / ${ctx.region})\n`);

  if (config.vpc) {
    const state = await vpc.describeVpc(ctx, config.vpc, config.app);
    if (state) {
      console.log(`  VPC: ${state.vpcId} (${state.cidr})`);
      console.log(`    Public subnets:  ${state.publicSubnetIds.join(', ') || 'none'}`);
      console.log(`    Private subnets: ${state.privateSubnetIds.join(', ') || 'none'}`);
      console.log(`    NAT Gateway:     ${state.natGatewayId ?? 'none'}`);
    } else {
      console.log('  VPC: NOT FOUND');
    }
  }

  if (config.rds) {
    const state = await rds.describeRds(ctx, config.rds, config.app);
    if (state) {
      const endpoint = state.proxyEndpoint ?? state.clusterEndpoint ?? state.instanceEndpoint;
      console.log(`  Database: ${endpoint}:${state.port}/${state.dbName}`);
      if (state.proxyEndpoint) console.log(`    Proxy: ${state.proxyEndpoint}`);
    } else {
      console.log('  Database: NOT FOUND');
    }
  }

  const cognitoStatusConfigs = config.cognito
    ? (Array.isArray(config.cognito) ? config.cognito : [config.cognito])
    : [];
  for (const cognitoConfig of cognitoStatusConfigs) {
    const state = await cognito.describeCognito(ctx, cognitoConfig, config.app);
    if (state) {
      console.log(`  Cognito: ${state.userPoolId} (${state.clients.length} clients)`);
    } else {
      const poolName = cognitoConfig.poolName ?? `${config.app}-user-pool`;
      console.log(`  Cognito: ${poolName} — NOT FOUND`);
    }
  }

  for (const lambdaConfig of config.lambda ?? []) {
    const state = await lambda.describeLambda(ctx, lambdaConfig.name);
    if (state) {
      console.log(`  Lambda: ${state.functionName} (${state.runtime}, ${state.memory}MB, ${(state.codeSize / 1024).toFixed(0)}KB)`);
    } else {
      console.log(`  Lambda: ${lambdaConfig.name} — NOT FOUND`);
    }
  }

  if (config.apiGateway) {
    const apiName = config.apiGateway.name ?? `${config.app}-api`;
    const state = await apiGateway.describeApiGateway(ctx, apiName);
    if (state) {
      console.log(`  API Gateway: ${state.apiEndpoint} (${state.routeCount} routes)`);
    } else {
      console.log(`  API Gateway: ${apiName} — NOT FOUND`);
    }
  }

  for (const tableConfig of config.dynamodb ?? []) {
    const state = await dynamodb.describeDynamoTable(ctx, tableConfig.name);
    if (state) {
      console.log(`  DynamoDB: ${state.tableName} (${state.status}, pk=${state.pk}${state.sk ? `, sk=${state.sk}` : ''})`);
    } else {
      console.log(`  DynamoDB: ${tableConfig.name} — NOT FOUND`);
    }
  }

  for (const ecrConfig of config.ecr ?? []) {
    const state = await ecsExpress.describeEcr(ctx, ecrConfig.name);
    if (state) {
      console.log(`  ECR: ${state.repoUri}`);
    } else {
      console.log(`  ECR: ${ecrConfig.name} — NOT FOUND`);
    }
  }

  for (const ecsConfig of config.ecsExpress ?? []) {
    const state = await ecsExpress.describeEcsExpress(ctx, ecsConfig.name);
    if (state) {
      console.log(`  ECS Express: ${state.serviceName} (${state.status})`);
    } else {
      console.log(`  ECS Express: ${ecsConfig.name} — NOT FOUND`);
    }
  }

  // ElastiCache
  if (config.elasticache) {
    const state = await elasticache.describeElastiCache(ctx, config.elasticache, config.app);
    if (state) {
      console.log(`  ElastiCache: ${state.replicationGroupId} (${state.nodeType}, ${state.status}, TLS=${state.transitEncryption})`);
    } else {
      console.log(`  ElastiCache: ${config.elasticache.name} — NOT FOUND`);
    }
  }

  // CloudFront
  for (const cfConfig of config.cloudfront ?? []) {
    const state = await cloudfront.describeCloudFront(ctx, cfConfig, config.app);
    if (state) {
      console.log(`  CloudFront: ${state.domainName} (${state.distributionId}, ${state.status})`);
    } else {
      console.log(`  CloudFront: ${cfConfig.name} — NOT FOUND`);
    }
  }

  // Step Functions
  for (const sfConfig of config.stepFunctions ?? []) {
    const state = await stepFunctions.describeStepFunction(ctx, sfConfig, config.app);
    if (state) {
      console.log(`  Step Functions: ${state.name} (${state.type}, ${state.status})`);
    } else {
      console.log(`  Step Functions: ${sfConfig.name} — NOT FOUND`);
    }
  }

  // SQS
  for (const sqsConfig of config.sqs ?? []) {
    const state = await sqs.describeSqs(ctx, sqsConfig, config.app);
    if (state) {
      console.log(`  SQS: ${sqsConfig.name} (~${state.approximateMessages} messages)`);
    } else {
      console.log(`  SQS: ${sqsConfig.name} — NOT FOUND`);
    }
  }

  console.log('');
}
