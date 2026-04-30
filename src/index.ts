/**
 * Forge — Direct AWS infrastructure management.
 * Programmatic API for use from deploy scripts and custom tooling.
 *
 * Two intended consumers:
 *   1. The CLI in `cli.ts` (entry point: `forge plan` / `forge apply` /
 *      `forge status` / `forge import` / `forge discover` / `forge diagram` /
 *      `forge destroy`).
 *   2. Custom scripts that need finer-grained control — e.g., a deploy
 *      pipeline that wants to apply a single resource type, or a CI job
 *      that wants to call `plan()` and post the result to a PR comment.
 *
 * Most consumers should use `defineConfig` + `plan` / `apply` / `status`
 * and let the engine do the orchestration. Reach for the per-resource
 * modules only when you need surgical operations the engine doesn't
 * expose (e.g., `applyLambda` to deploy code without touching VPC or
 * Cognito).
 */

// ---------------------------------------------------------------------------
// Core: config, context, engine commands
// ---------------------------------------------------------------------------

export { defineConfig } from './config.js';
export type {
  ForgeConfig,
  // Resource config types — exported so custom-tooling consumers can
  // strongly type partial configs without re-deriving them.
  VpcConfig,
  RdsConfig,
  CognitoConfig,
  CognitoClientConfig,
  LambdaFunctionConfig,
  LambdaLayerConfig,
  InlinePolicyStatement,
  NamedInlinePolicy,
  FlatInlinePolicy,
  InlinePolicy,
  ApiGatewayConfig,
  ApiGatewayRouteConfig,
  ApiGatewayRouteEntry,
  DynamoTableConfig,
  DynamoGsiConfig,
  S3BucketConfig,
  EcrRepoConfig,
  EcsExpressConfig,
  EventBridgeRuleConfig,
  IamRoleConfig,
  IamUserConfig,
  IamGroupConfig,
  IamInstanceProfileConfig,
  IamManagedPolicyConfig,
  SsmParameterConfig,
  SnsTopicConfig,
  SnsSubscriptionConfig,
  CloudFrontDistributionConfig,
  ElastiCacheConfig,
  StepFunctionConfig,
  SqsQueueConfig,
  CloudWatchAlarmConfig,
  CloudWatchLogGroupConfig,
  Route53HostedZoneConfig,
  Route53RecordConfig,
  AcmCertificateConfig,
  KmsKeyConfig,
  SecretConfig,
  PinpointAppConfig,
  SecurityGroupConfig,
  SecurityGroupRule,
  EventBusConfig,
  VpcEndpointConfig,
  AlbConfig,
  AlbTargetGroupConfig,
  AlbListenerConfig,
  AlbListenerRuleConfig,
  EcsClusterConfig,
  EcsServiceConfig,
  EcsTaskDefConfig,
  EcsContainerConfig,
  WafWebAclConfig,
  WafRuleConfig,
  RestApiConfig,
  RestApiResourceConfig,
  LaunchTemplateConfig,
  AutoScalingGroupConfig,
  BedrockConfig,
  BedrockProvisionedThroughputConfig,
  BedrockGuardrailConfig,
  BedrockKnowledgeBaseConfig,
  BedrockAgentConfig,
  SagemakerEndpointConfig,
  OpenSearchDomainConfig,
  GlueDatabaseConfig,
  AthenaWorkgroupConfig,
} from './config.js';
export { isNamedInlinePolicy } from './config.js';

export {
  initAwsContext,
  withContext,
  templatizeName,
  awaitIamPropagation,
  canonicalize,
  lambdaName,
  toLambdaArn,
  ForgeError,
  ForgeRefusedError,
  ForgeDriftError,
  ForgeAwsError,
} from './aws.js';
export type { AwsContext } from './aws.js';

export { plan, apply, status } from './engine.js';
export { importStack } from './import.js';
export { discoverApp } from './discover.js';
export { generateDiagram } from './diagram.js';

// ---------------------------------------------------------------------------
// Plan + diff types
// ---------------------------------------------------------------------------

export type { Plan, ChangeType, ResourceChange, FieldChange } from './diff.js';
export { createPlan, displayPlan, addChange } from './diff.js';

// ---------------------------------------------------------------------------
// Resource modules
//
// Each module exports describe / plan / apply / destroy functions plus a
// state interface. Use these when you need fine-grained control beyond
// what `apply()` provides (e.g., deploying just Lambda code without
// touching infra, or running plan against a single resource type).
// ---------------------------------------------------------------------------

// Network / data
export * as vpc from './resources/vpc.js';
export * as vpcEndpoint from './resources/vpc-endpoint.js';
export * as rds from './resources/rds.js';
export * as elasticache from './resources/elasticache.js';
export * as dynamodb from './resources/dynamodb.js';
export * as s3 from './resources/s3.js';
export * as ecr from './resources/ecr.js';
export * as kms from './resources/kms.js';
export * as secrets from './resources/secrets-manager.js';
export * as ssm from './resources/ssm.js';

// Auth
export * as cognito from './resources/cognito.js';
export * as iam from './resources/iam.js';
export * as iamManagedPolicy from './resources/iam-managed-policy.js';
export * as securityGroup from './resources/security-group.js';

// Compute
export * as lambda from './resources/lambda.js';
export * as lambdaLayer from './resources/lambda-layer.js';
export * as ecs from './resources/ecs.js';
export * as ecsExpress from './resources/ecs-express.js';
export * as ec2Asg from './resources/ec2-asg.js';

// API / front-of-house
export * as apiGateway from './resources/api-gateway.js';
export * as restApi from './resources/rest-api.js';
export * as alb from './resources/alb.js';
export * as cloudfront from './resources/cloudfront.js';
export * as route53 from './resources/route53.js';
export * as acm from './resources/acm.js';
export * as waf from './resources/waf.js';

// Async / event
export * as sqs from './resources/sqs.js';
export * as sns from './resources/sns.js';
export * as eventBus from './resources/event-bus.js';
export * as eventbridge from './resources/eventbridge.js';
export * as stepFunctions from './resources/step-functions.js';
export * as pinpoint from './resources/pinpoint.js';

// Observability
export * as cloudwatch from './resources/cloudwatch.js';

// AI / ML / data
export * as bedrock from './resources/bedrock.js';
export * as sagemaker from './resources/sagemaker.js';
export * as opensearch from './resources/opensearch.js';
export * as glueAthena from './resources/glue-athena.js';
