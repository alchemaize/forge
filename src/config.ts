/**
 * Forge configuration types.
 *
 * Each app gets a forge.config.ts that declares its desired infrastructure.
 * Forge reads live state from AWS, diffs against this config, and applies changes.
 */

// ---------------------------------------------------------------------------
// Resource tier — controls destroy safety
// ---------------------------------------------------------------------------

export type ResourceTier = 'data' | 'compute' | 'config';

// ---------------------------------------------------------------------------
// VPC
// ---------------------------------------------------------------------------

export interface VpcConfig {
  /** Create a new VPC or reference an existing one by ID */
  mode: 'create' | 'lookup';
  /** Required for lookup mode */
  vpcId?: string;
  /** CIDR block for new VPC (default: 10.0.0.0/16) */
  cidr?: string;
  /** Number of AZs (default: 2) */
  azCount?: number;
  /** Create NAT gateway (default: true for create mode) */
  natGateway?: boolean;
  /** Subnet layout: public + private + isolated (default) */
  subnetLayout?: 'public-private-isolated' | 'public-private' | 'public-only';
}

// ---------------------------------------------------------------------------
// RDS / Aurora
// ---------------------------------------------------------------------------

export interface RdsConfig {
  /** Aurora Serverless v2 (default) or standard RDS instance */
  mode: 'aurora-serverless-v2' | 'instance';
  /** Engine: postgres (default) */
  engine?: 'postgres';
  /** Engine version (default: 16.4 for aurora, 15 for instance) */
  engineVersion?: string;
  /** Database name */
  dbName: string;
  /** Master username (default: {app}_admin) */
  masterUsername?: string;
  /**
   * Override the cluster identifier for Aurora or instance identifier for RDS.
   * Default: {app}-aurora (Aurora) or {app}-db (instance).
   * Use this when adopting CDK-created resources with non-standard names
   * (e.g. 'txdmvrtsdemo-auroracluster23d869c0-sg0iubt71cmf').
   */
  clusterId?: string;
  /** Instance class for standard mode (default: db.t4g.micro) */
  instanceClass?: string;
  /** Min ACU for serverless (default: 0.5) */
  minCapacity?: number;
  /** Max ACU for serverless (default: 4) */
  maxCapacity?: number;
  /** Allocated storage GB for instance mode (default: 20) */
  storage?: number;
  /** Enable RDS Proxy (default: true for aurora) */
  proxy?: boolean;
  /** Force SSL (default: true) */
  forceSsl?: boolean;
  /** Deletion protection (default: false for pre-prod) */
  deletionProtection?: boolean;
  /** Store password in Secrets Manager (default: true) or SSM */
  passwordStore?: 'secrets-manager' | 'ssm';
  /** Enable pgvector extension */
  pgvector?: boolean;
}

// ---------------------------------------------------------------------------
// Cognito
// ---------------------------------------------------------------------------

export interface CognitoClientConfig {
  name: string;
  authFlows?: string[];
  generateSecret?: boolean;
  callbackUrls?: string[];
  logoutUrls?: string[];
  supportedProviders?: string[];
}

export interface CognitoTriggerConfig {
  preTokenGeneration?: string;   // Lambda function name or ARN
  postConfirmation?: string;     // Lambda function name or ARN
  preSignUp?: string;
  customMessage?: string;
}

export interface CognitoConfig {
  poolName?: string;
  emailSignup?: boolean;
  appleSignIn?: boolean;
  googleSignIn?: boolean;
  clients?: CognitoClientConfig[];
  triggers?: CognitoTriggerConfig;
  /** SES email sender (default: Cognito default) */
  emailSender?: string;
  /** Custom domain prefix */
  domainPrefix?: string;
  /** Password policy */
  passwordPolicy?: {
    minLength?: number;
    requireLowercase?: boolean;
    requireUppercase?: boolean;
    requireDigits?: boolean;
    requireSymbols?: boolean;
  };
  /** MFA setting */
  mfa?: 'OFF' | 'OPTIONAL' | 'REQUIRED';
}

// ---------------------------------------------------------------------------
// Lambda
// ---------------------------------------------------------------------------

export interface LambdaFunctionConfig {
  /** Unique name for this function */
  name: string;
  /** Entry point file (for esbuild) */
  entry?: string;
  /** Handler (default: index.handler) */
  handler?: string;
  /** Runtime (default: nodejs20.x) */
  runtime?: string;
  /** Memory MB (default: 512) */
  memory?: number;
  /** Timeout seconds (default: 30) */
  timeout?: number;
  /** Architecture (default: arm64) */
  architecture?: 'arm64' | 'x86_64';
  /** Environment variables */
  env?: Record<string, string>;
  /** Place in VPC (default: false) */
  vpc?: boolean;
  /** Additional IAM policy ARNs */
  policies?: string[];
  /** Inline IAM policy statements */
  inlinePolicies?: Array<{
    effect: 'Allow' | 'Deny';
    actions: string[];
    resources: string[];
  }>;
  /** Layers (ARNs) */
  layers?: string[];
}

// ---------------------------------------------------------------------------
// API Gateway
// ---------------------------------------------------------------------------

export interface ApiGatewayRouteConfig {
  /** Route key: "GET /health", "POST /auth/signup", etc. */
  routeKey: string;
  /** Skip JWT authorizer (default: false) */
  public?: boolean;
  /** Override target Lambda (default: first lambda in config) */
  targetLambda?: string;
}

export interface ApiGatewayConfig {
  /** API name (default: {app}-api) */
  name?: string;
  /** CORS origins (default: ['*']) */
  corsOrigins?: string[];
  /** CORS methods (default: standard set) */
  corsMethods?: string[];
  /** Use catch-all {proxy+} with JWT (default: true) */
  catchAll?: boolean;
  /** Public routes (no JWT) */
  publicRoutes?: string[];
  /** Explicit authenticated routes (only if catchAll is false) */
  authenticatedRoutes?: string[];
  /** Cognito user pool ID for JWT authorizer (auto-resolved if cognito config exists) */
  cognitoPoolId?: string;
  /** Cognito client ID for JWT audience */
  cognitoClientId?: string;
}

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------

export interface DynamoGsiConfig {
  name: string;
  pk: string;
  sk?: string;
  projection?: 'ALL' | 'KEYS_ONLY' | string[];
}

export interface DynamoTableConfig {
  name: string;
  pk: string;
  pkType?: 'S' | 'N';
  sk?: string;
  skType?: 'S' | 'N';
  gsi?: DynamoGsiConfig[];
  ttl?: string;
  billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

export interface S3BucketConfig {
  /** Bucket name. Supports {account} and {region} placeholders. */
  name: string;
  /** Server-side encryption (default: AES256) */
  encryption?: 'AES256' | 'aws:kms';
  /** Block all public access (default: true) */
  blockPublicAccess?: boolean;
  /** Lifecycle rules */
  lifecycle?: Array<{
    prefix?: string;
    expirationDays: number;
  }>;
  /** CORS configuration */
  cors?: {
    origins: string[];
    methods: string[];
    headers?: string[];
  };
  /** Enable versioning */
  versioning?: boolean;
}

// ---------------------------------------------------------------------------
// ECR
// ---------------------------------------------------------------------------

export interface EcrRepoConfig {
  name: string;
  /** Keep last N images (default: 5) */
  lifecycleKeep?: number;
  /** Enable scan on push (default: true) */
  scanOnPush?: boolean;
}

// ---------------------------------------------------------------------------
// ECS Express Mode
// ---------------------------------------------------------------------------

export interface EcsExpressConfig {
  name: string;
  /** CPU units (default: 512) */
  cpu?: number;
  /** Memory MB (default: 1024) */
  memory?: number;
  /** Container port (default: 8080) */
  port?: number;
  /** Health check path (default: /health) */
  healthCheckPath?: string;
  /** Assign public IP (default: true) */
  publicIp?: boolean;
  /** ECR repo name (auto-resolved if ecr config exists) */
  ecrRepo?: string;
  /** Environment variables for the container */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

export interface EventBridgeRuleConfig {
  name: string;
  /** Cron or rate expression */
  schedule?: string;
  /** Event pattern (JSON) */
  eventPattern?: Record<string, unknown>;
  /** Target Lambda function name */
  targetLambda: string;
  /** Input to pass to target */
  input?: string;
  /** Enabled (default: true) */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// IAM
// ---------------------------------------------------------------------------

export interface IamRoleConfig {
  name: string;
  /** Trust policy principal services */
  trustServices: string[];
  /** Managed policy ARNs to attach */
  managedPolicies?: string[];
  /** Inline policy statements */
  inlineStatements?: Array<{
    effect: 'Allow' | 'Deny';
    actions: string[];
    resources: string[];
  }>;
}

// ---------------------------------------------------------------------------
// SSM Parameters
// ---------------------------------------------------------------------------

export interface SsmParameterConfig {
  name: string;
  value: string;
  type?: 'String' | 'SecureString';
  description?: string;
}

// ---------------------------------------------------------------------------
// SNS
// ---------------------------------------------------------------------------

export interface SnsTopicConfig {
  name: string;
  platform?: 'APNS' | 'GCM';
  /** Display name for email subscriptions */
  displayName?: string;
}

// ---------------------------------------------------------------------------
// CloudFront
// ---------------------------------------------------------------------------

export interface CloudFrontDistributionConfig {
  /** Logical name for this distribution (used in status/plan output) */
  name: string;
  /** S3 bucket origin (resolved from s3 config if name matches) */
  s3Origin?: string;
  /** Custom origin (ALB, ECS Express, API Gateway, etc.) */
  customOrigin?: string;
  /** Default root object (default: index.html) */
  defaultRootObject?: string;
  /** Viewer protocol policy (default: redirect-to-https) */
  viewerProtocolPolicy?: 'allow-all' | 'https-only' | 'redirect-to-https';
  /** SPA error responses — map 403/404 to /index.html */
  spaErrorResponses?: boolean;
  /** Custom domain aliases */
  aliases?: string[];
  /** ACM certificate ARN (required if aliases are set) */
  certificateArn?: string;
  /** WAF Web ACL ARN */
  webAclArn?: string;
  /** Price class (default: PriceClass_100 — US/Canada/Europe) */
  priceClass?: 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All';
}

// ---------------------------------------------------------------------------
// ElastiCache (Redis)
// ---------------------------------------------------------------------------

export interface ElastiCacheConfig {
  /** Cluster/replication group name */
  name: string;
  /**
   * Override the replication group ID for lookup.
   * Default: uses `name`. Use this when adopting CDK-created resources
   * with non-standard IDs (e.g. 'str17cldn0xmk8a0').
   */
  replicationGroupId?: string;
  /** Engine (default: redis) */
  engine?: 'redis' | 'valkey';
  /** Node type (default: cache.t3.micro) */
  nodeType?: string;
  /** Number of cache nodes / clusters (default: 1) */
  numNodes?: number;
  /** Enable automatic failover (requires numNodes >= 2) */
  automaticFailover?: boolean;
  /** Enable transit encryption / TLS (default: true) */
  transitEncryption?: boolean;
  /** Enable at-rest encryption (default: true) */
  atRestEncryption?: boolean;
  /** KMS key ARN for at-rest encryption */
  kmsKeyArn?: string;
  /** Auth token secret ARN (Secrets Manager) */
  authTokenSecretArn?: string;
  /** Place in VPC isolated subnets (default: true) */
  vpc?: boolean;
}

// ---------------------------------------------------------------------------
// Step Functions
// ---------------------------------------------------------------------------

export interface StepFunctionStepConfig {
  name: string;
  /** Target Lambda function name */
  targetLambda: string;
  /** Payload template (JSON) */
  payload?: Record<string, unknown>;
  /** Retry config */
  retry?: {
    errors?: string[];
    interval?: number;
    maxAttempts?: number;
    backoffRate?: number;
  };
}

export interface StepFunctionConfig {
  /** State machine name */
  name: string;
  /** State machine type (default: STANDARD) */
  type?: 'STANDARD' | 'EXPRESS';
  /** Timeout in minutes (default: 5) */
  timeout?: number;
  /** Enable X-Ray tracing (default: true) */
  tracing?: boolean;
  /** CloudWatch log level (default: ALL) */
  logLevel?: 'ALL' | 'ERROR' | 'FATAL' | 'OFF';
  /** Definition as Amazon States Language JSON */
  definition?: Record<string, unknown>;
  /** DLQ for failed executions (SQS queue name) */
  dlqName?: string;
}

// ---------------------------------------------------------------------------
// SQS
// ---------------------------------------------------------------------------

export interface SqsQueueConfig {
  /** Queue name */
  name: string;
  /** Message retention period in days (default: 4) */
  retentionDays?: number;
  /** Visibility timeout in seconds (default: 30) */
  visibilityTimeout?: number;
  /** Enable server-side encryption (default: true) */
  encryption?: boolean;
  /** Enforce SSL (default: true) */
  enforceSSL?: boolean;
  /** Dead letter queue name */
  dlqName?: string;
  /** Max receive count before sending to DLQ (default: 3) */
  maxReceiveCount?: number;
  /** FIFO queue (default: false) */
  fifo?: boolean;
}

// ---------------------------------------------------------------------------
// CloudWatch Alarms
// ---------------------------------------------------------------------------

export interface CloudWatchAlarmConfig {
  /** Alarm name */
  name: string;
  /** Description */
  description?: string;
  /** Metric namespace */
  namespace: string;
  /** Metric name */
  metricName: string;
  /** Dimensions */
  dimensions?: Record<string, string>;
  /** Statistic (default: Average) */
  statistic?: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount' | 'p99' | 'p95' | 'p90';
  /** Period in seconds (default: 300) */
  period?: number;
  /** Evaluation periods (default: 1) */
  evaluationPeriods?: number;
  /** Threshold */
  threshold: number;
  /** Comparison operator */
  comparisonOperator?: 'GreaterThanThreshold' | 'LessThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold';
  /** SNS topic name for alarm actions */
  alarmTopicName?: string;
  /** Treat missing data (default: notBreaching) */
  treatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing';
  /** Math expression (overrides namespace/metricName) */
  mathExpression?: string;
  /** Metrics used in math expression */
  usingMetrics?: Record<string, { namespace: string; metricName: string; dimensions?: Record<string, string>; statistic?: string }>;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface ForgeConfig {
  /** Application name — used as prefix for resource naming */
  app: string;
  /** AWS CLI profile */
  profile: string;
  /** AWS region (default: us-east-1) */
  region?: string;

  /** Resource declarations */
  vpc?: VpcConfig;
  rds?: RdsConfig;
  /** Single Cognito pool or array of pools (multi-pool apps like txdmv-rts) */
  cognito?: CognitoConfig | CognitoConfig[];
  lambda?: LambdaFunctionConfig[];
  apiGateway?: ApiGatewayConfig;
  dynamodb?: DynamoTableConfig[];
  s3?: S3BucketConfig[];
  ecr?: EcrRepoConfig[];
  ecsExpress?: EcsExpressConfig[];
  eventbridge?: EventBridgeRuleConfig[];
  iam?: IamRoleConfig[];
  ssm?: SsmParameterConfig[];
  sns?: SnsTopicConfig[];
  cloudfront?: CloudFrontDistributionConfig[];
  elasticache?: ElastiCacheConfig;
  stepFunctions?: StepFunctionConfig[];
  sqs?: SqsQueueConfig[];
  alarms?: CloudWatchAlarmConfig[];
}

/**
 * Type-safe config helper.
 */
export function defineConfig(config: ForgeConfig): ForgeConfig {
  return {
    region: 'us-east-1',
    ...config,
  };
}
