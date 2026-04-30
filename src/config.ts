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
  /** Days of automated backup retention (default: 1 day for instance, 7 for Aurora). */
  backupRetention?: number;
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
  /** Lambda function name or ARN. Sends Cognito verification emails (replaces SES default). */
  customEmailSender?: string;
  /** KMS key ARN. Required when customEmailSender is set — Cognito uses this to
   * encrypt the verification code that gets sent to the CustomEmailSender Lambda. */
  customSenderKmsKey?: string;
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
  /** Custom user attributes (added to the pool Schema). Cognito stores these
   * with a 'custom:' prefix on user objects. Cognito doesn't allow modifying or
   * removing schema attributes after creation — Forge can ADD missing ones to an
   * existing pool but won't try to alter or delete existing attributes. */
  customAttributes?: Array<{
    name: string;
    type?: 'String' | 'Number' | 'DateTime' | 'Boolean';
    mutable?: boolean;
    required?: boolean;
  }>;
  /** Account recovery preferences. EMAIL_ONLY is the most common. */
  accountRecovery?: 'EMAIL_ONLY' | 'PHONE_ONLY' | 'PHONE_AND_EMAIL' | 'EMAIL_AND_PHONE';
}

// ---------------------------------------------------------------------------
// IAM inline policies (used by Lambda role config)
// ---------------------------------------------------------------------------

export interface InlinePolicyStatement {
  sid?: string;
  effect: 'Allow' | 'Deny';
  actions: string[];
  resources: string[];
  conditions?: Record<string, unknown>;
  principal?: unknown;
}

/**
 * Named-form inline policy. Recommended for new configs and the round-trip
 * shape Forge import emits because it preserves the policy's name in the
 * IAM console and the plan output. CFN-imported policies always land here.
 */
export interface NamedInlinePolicy {
  name: string;
  statements: InlinePolicyStatement[];
}

/**
 * Flat-form inline policy. Backward-compat shape; multiple flat entries
 * are merged into a single 'forge-inline' policy on apply. Discriminate
 * from NamedInlinePolicy via isNamedInlinePolicy().
 */
export interface FlatInlinePolicy {
  effect: 'Allow' | 'Deny';
  actions: string[];
  resources: string[];
}

export type InlinePolicy = NamedInlinePolicy | FlatInlinePolicy;

/**
 * Type guard for the named form. Use this in apply paths instead of
 * runtime probing on `(p as any).name` so a typo like `statments`
 * fails the type check rather than silently falling through to flat.
 */
export function isNamedInlinePolicy(p: InlinePolicy): p is NamedInlinePolicy {
  return typeof (p as NamedInlinePolicy).name === 'string'
    && Array.isArray((p as NamedInlinePolicy).statements);
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
  /** Runtime (default: nodejs22.x) */
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
  /**
   * Existing IAM role ARN to use for this function.
   * When set, Forge skips role creation/lookup and uses this ARN directly.
   * Required when adopting CDK-managed functions whose roles don't follow
   * the {functionName}-role naming convention. Without this, Forge would
   * create a fresh role and silently swap the function over to it on apply,
   * losing all custom permissions.
   */
  roleArn?: string;
  /** Managed policy ARNs to attach to the role. Forge syncs these additively
   * (attaches missing ones, never detaches policies not in config). */
  policies?: string[];
  /**
   * Inline IAM policies to put on the role.
   *
   * Supports two forms (mix freely):
   *
   * 1. Named policy with multiple statements (preferred — can fully own CDK-named policies):
   *      { name: 'MyPolicy', statements: [{ effect: 'Allow', actions: [...], resources: [...] }] }
   *
   * 2. Flat single statement (backward-compat — auto-grouped under a 'forge-inline' policy):
   *      { effect: 'Allow', actions: [...], resources: [...] }
   *
   * On apply, named-form entries are PutRolePolicy'd by their explicit name; flat-form
   * entries are merged into a single 'forge-inline' policy. CFN-named policies that
   * Forge captures via import are written in the named form so they round-trip cleanly.
   */
  inlinePolicies?: InlinePolicy[];
  /** Layers (ARNs) */
  layers?: string[];
  /** Function URL configuration. When set, Forge ensures the URL exists with the
   * specified auth + CORS. When unset, Forge leaves any existing URL alone (adoption
   * preserves whatever's there). Forge never deletes a URL even if config changes. */
  functionUrl?: {
    /** Auth type: NONE for public, AWS_IAM for IAM-signed requests. Default: NONE */
    authType?: 'NONE' | 'AWS_IAM';
    /** CORS configuration for browser clients */
    cors?: {
      allowOrigins?: string[];
      allowMethods?: string[];
      allowHeaders?: string[];
      allowCredentials?: boolean;
      maxAge?: number;
      exposeHeaders?: string[];
    };
  };
  /** Event source mappings (SQS, Kinesis, DynamoDB Streams → Lambda).
   * When set, Forge ensures mappings exist with the specified batch size etc.
   * Adoption-safe: existing mappings not in config are preserved (no auto-delete). */
  eventSources?: Array<{
    /** Source ARN (e.g. arn:aws:sqs:us-east-1:123:my-queue) */
    source: string;
    /** Batch size (default depends on source: 10 for SQS, 100 for Kinesis/Dynamo) */
    batchSize?: number;
    /** Max batching window in seconds (0-300, default 0) */
    maximumBatchingWindowInSeconds?: number;
    /** Enable partial batch failure reporting (SQS only). Default: false */
    reportBatchItemFailures?: boolean;
  }>;
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

/**
 * Route entries can be either a plain "GET /path" string (auth and target
 * Lambda implied by the array they're in) or a structured object with
 * per-route overrides.
 */
export type ApiGatewayRouteEntry = string | ApiGatewayRouteConfig;

export interface ApiGatewayConfig {
  /** API name (default: {app}-api) */
  name?: string;
  /** CORS origins (default: ['*']) */
  corsOrigins?: string[];
  /** CORS methods (default: standard set) */
  corsMethods?: string[];
  /** Use catch-all {proxy+} with JWT (default: true) */
  catchAll?: boolean;
  /**
   * Public routes (no JWT). Each entry is either a route key string like
   * "GET /health" or an object `{ routeKey, targetLambda }` to direct the
   * route at a specific Lambda by name (e.g. for an upload endpoint
   * routed at `upload-handler`, distinct from the default API Lambda).
   */
  publicRoutes?: ApiGatewayRouteEntry[];
  /**
   * Authenticated routes (require JWT). Used when `catchAll` is false, or
   * alongside it for routes that should land on a specific Lambda rather
   * than the catch-all integration.
   */
  authenticatedRoutes?: ApiGatewayRouteEntry[];
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
  /** Bucket policy as a parsed JSON object (Version + Statement array).
   * When set, Forge ensures the bucket has this policy. When unset, Forge leaves
   * any existing policy alone. Parsed object form (not string) for cleaner diffs. */
  policy?: object;
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
  /**
   * Event bus to attach the rule to. Defaults to 'default' (the per-account
   * AWS-managed bus). Set this to a custom bus name (e.g., 'yeon-crm-events')
   * to attach the rule to a bus declared in `eventBuses`.
   */
  eventBusName?: string;
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
  /**
   * Parameter value. For SecureString parameters Forge stores the value
   * encrypted with the AWS-managed `alias/aws/ssm` key by default; pass
   * a kmsKeyId to use a customer-managed key.
   *
   * SECURITY: do not commit secrets to forge.config.ts. Use a setup
   * script or pass via environment to keep them out of git. Forge import
   * skips parameter values matching secret patterns by design.
   */
  value: string;
  type?: 'String' | 'SecureString' | 'StringList';
  description?: string;
  /** Customer-managed KMS key for SecureString (optional). */
  kmsKeyId?: string;
  /** Tier (default: Standard). Advanced unlocks larger values + policies. */
  tier?: 'Standard' | 'Advanced' | 'Intelligent-Tiering';
}

// ---------------------------------------------------------------------------
// VPC Endpoints
// ---------------------------------------------------------------------------

export interface VpcEndpointConfig {
  /**
   * Service name to expose privately. Either:
   *   - Short alias: 's3', 'dynamodb', 'ecr.api', 'ecr.dkr', 'secretsmanager',
   *     'sts', 'kms', 'logs', 'monitoring', 'sqs', 'sns', 'lambda', 'events',
   *     'ssm', 'ssmmessages', 'ec2messages'
   *   - Full service name: 'com.amazonaws.us-east-1.s3'
   * Forge expands the alias to the regional service name automatically.
   */
  service: string;
  /**
   * Endpoint type. Gateway is free and only available for s3 and dynamodb;
   * everything else is Interface (per-AZ ENIs, $7.20/mo each plus data).
   * Default: inferred from service ('s3' / 'dynamodb' → Gateway, else Interface).
   */
  type?: 'Gateway' | 'Interface';
  /**
   * VPC ID. If omitted, Forge uses the parent config's VPC (lookup mode)
   * or the freshly-created VPC's ID (create mode).
   */
  vpcId?: string;
  /**
   * Route tables (Gateway endpoints) or subnets (Interface endpoints) the
   * endpoint should be associated with. If omitted, Forge picks all the
   * VPC's private subnets / route tables.
   */
  subnetIds?: string[];
  routeTableIds?: string[];
  /** Security group IDs (Interface endpoints only). */
  securityGroupIds?: string[];
  /** Private DNS — Interface endpoints only. Default: true. */
  privateDnsEnabled?: boolean;
  /** Endpoint policy (JSON). Default: full access. */
  policy?: object;
}

// ---------------------------------------------------------------------------
// SNS
// ---------------------------------------------------------------------------

export interface SnsSubscriptionConfig {
  /** Protocol (e.g., 'email', 'sqs', 'lambda', 'https'). */
  protocol: 'email' | 'email-json' | 'sms' | 'sqs' | 'lambda' | 'http' | 'https';
  /**
   * Endpoint. The shape depends on protocol:
   *   email     → 'ops@example.com'
   *   sqs       → arn:aws:sqs:... or a bare queue name resolved against
   *               the same forge config (Forge will look it up).
   *   lambda    → arn:aws:lambda:... or a bare function name in the
   *               same config.
   *   http(s)   → full URL.
   */
  endpoint: string;
  /** Filter policy applied at subscription level. */
  filterPolicy?: Record<string, unknown>;
  /** Raw message delivery (skips SNS envelope; useful for SQS / Lambda). */
  rawMessageDelivery?: boolean;
}

export interface SnsTopicConfig {
  name: string;
  /** Mobile push platform (APNS / GCM). */
  platform?: 'APNS' | 'GCM';
  /** Display name shown to email subscribers. */
  displayName?: string;
  /** FIFO topic (default: false). FIFO topic names must end in `.fifo`. */
  fifo?: boolean;
  /** KMS key ARN/alias for SSE-KMS encryption (default: none). */
  kmsKeyId?: string;
  /** Subscriptions attached to the topic. Forge ensures each one exists
   * and adds missing ones; existing subscriptions outside the config are
   * left alone (adoption-safe). */
  subscriptions?: SnsSubscriptionConfig[];
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
// CloudWatch Log Groups
// ---------------------------------------------------------------------------

export interface CloudWatchLogGroupConfig {
  /**
   * Log group name. Lambda function logs go to `/aws/lambda/<function-name>`
   * by convention; declaring the log group here lets Forge own retention
   * policy and KMS encryption upfront instead of letting AWS default to
   * "Never expire" on first invocation.
   */
  name: string;
  /**
   * Retention in days. Default: 30. AWS allowed values: 1, 3, 5, 7, 14,
   * 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192,
   * 2557, 2922, 3288, 3653. `Infinity` (CloudWatch's default) is not
   * recommended for cost reasons.
   */
  retentionDays?: number;
  /** KMS key ARN for log group encryption (default: AWS-managed). */
  kmsKeyArn?: string;
}

// ---------------------------------------------------------------------------
// Route 53
// ---------------------------------------------------------------------------

export interface Route53RecordConfig {
  /** Record name. Trailing dot optional; Forge normalizes. */
  name: string;
  /** Record type. */
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV' | 'CAA';
  /** TTL in seconds (default: 300). Required unless using `alias`. */
  ttl?: number;
  /** Resource records (RDATA). For TXT, individual values are quoted
   * automatically. */
  values?: string[];
  /** Alias target. Used for ALB / CloudFront / S3 website / API Gateway
   * targets. When set, ttl is ignored. */
  alias?: {
    /** DNS name of the target (e.g., d123.cloudfront.net or alb-foo-123.region.elb.amazonaws.com). */
    dnsName: string;
    /** Hosted zone ID of the alias target. CloudFront uses Z2FDTNDATAQYW2;
     * S3 website endpoints have per-region zone IDs; ALBs publish theirs. */
    hostedZoneId: string;
    /** Whether to evaluate target health (default: false). */
    evaluateTargetHealth?: boolean;
  };
}

export interface Route53HostedZoneConfig {
  /** Domain name (e.g., 'example.com'). Trailing dot optional. */
  name: string;
  /** Comment shown in the Route 53 console. */
  comment?: string;
  /**
   * Private hosted zone. When true, must specify `vpcs` to associate.
   * Forge defaults to public.
   */
  privateZone?: boolean;
  /** VPC IDs to associate (private zones only). */
  vpcs?: Array<{ vpcId: string; vpcRegion: string }>;
  /** Records in this zone. Adoption-safe: extra records in AWS but not in
   * config are left alone. */
  records?: Route53RecordConfig[];
}

// ---------------------------------------------------------------------------
// ACM (Certificate Manager)
// ---------------------------------------------------------------------------

export interface AcmCertificateConfig {
  /**
   * Logical name used in plan/status output. Forge looks up the actual
   * certificate by domain name.
   */
  name: string;
  /** Primary domain name. Wildcards (`*.example.com`) supported. */
  domainName: string;
  /** Subject Alternative Names (SANs). */
  subjectAlternativeNames?: string[];
  /**
   * Validation method. 'DNS' is recommended (auto-renews); 'EMAIL'
   * requires manual click-through every 13 months.
   */
  validation?: 'DNS' | 'EMAIL';
  /**
   * Hosted zone name to auto-create DNS validation records in. When set
   * AND validation is 'DNS', Forge writes the _acmchallenge CNAME records
   * into this zone automatically. When unset, the user is responsible for
   * adding the DNS records (Forge will print them).
   */
  validationZoneName?: string;
  /**
   * Certificate transparency logging. Default: ENABLED. Disable only
   * when AWS recommends it (rare).
   */
  transparencyLogging?: boolean;
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
// Lambda Layer (standalone — referenced by Lambda config.layers ARNs)
// ---------------------------------------------------------------------------

export interface LambdaLayerConfig {
  /** Layer name (used as the AWS-side identifier) */
  name: string;
  /** Description (set on each new version) */
  description?: string;
  /** Compatible runtimes (e.g. ['nodejs22.x']). Used on PublishLayerVersion. */
  compatibleRuntimes?: string[];
  /** Compatible architectures (default: ['x86_64', 'arm64']) */
  compatibleArchitectures?: ('x86_64' | 'arm64')[];
  /** Path to a local zip file to upload as the layer content. Required to
   * PublishLayerVersion; without it Forge can only adopt-by-describe. */
  zipPath?: string;
}

// ---------------------------------------------------------------------------
// Custom EventBus
// ---------------------------------------------------------------------------

export interface EventBusConfig {
  /** Bus name. The default bus is named 'default' and isn't manageable here —
   * Forge creates user-defined buses only. */
  name: string;
}

// ---------------------------------------------------------------------------
// Security Group (standalone — distinct from auto-created VPC SG chain)
// ---------------------------------------------------------------------------

export interface SecurityGroupRule {
  /** IP protocol (tcp, udp, icmp, or -1 for all) */
  protocol: 'tcp' | 'udp' | 'icmp' | '-1';
  /** Port range start (omit for all ports / icmp) */
  fromPort?: number;
  /** Port range end (omit to use fromPort) */
  toPort?: number;
  /** IPv4 CIDR block (e.g. '10.0.0.0/16'). Mutually exclusive with sourceSg. */
  cidrIp?: string;
  /** Source security group name (resolved to GroupId at apply time). */
  sourceSg?: string;
  /** Optional description (helpful for debugging which rule is which) */
  description?: string;
}

export interface SecurityGroupConfig {
  /** Security group name (Forge looks up by name within the VPC) */
  name: string;
  /** Human description (required by AWS) */
  description: string;
  /** VPC ID. Defaults to config.vpc.vpcId if available. */
  vpcId?: string;
  /** Inbound rules */
  ingress?: SecurityGroupRule[];
  /** Outbound rules. AWS adds a default allow-all egress on create; Forge replaces
   * with the config rules if specified, leaves the default if not. */
  egress?: SecurityGroupRule[];
  /**
   * Revoke any rule that's in AWS but not in config (full sync).
   *
   * Default: false. With pruneRules off, Forge only ADDs rules; rules removed
   * from config persist in AWS until manually revoked. This is the safer
   * default for adoption (Forge won't accidentally remove rules it didn't
   * originally know about).
   *
   * Turn on for security-critical groups where the config should be the
   * authoritative source of truth (e.g., a public-facing ALB SG where
   * leaving extra ingress rules would be a real security hole).
   */
  pruneRules?: boolean;
}

// ---------------------------------------------------------------------------
// IAM Managed Policy (standalone, not Lambda role inline)
// ---------------------------------------------------------------------------

export interface IamManagedPolicyConfig {
  /** Policy name (used as the AWS-side identifier — Forge looks it up by name) */
  name: string;
  /** Description (used on create + update if it differs) */
  description?: string;
  /**
   * Policy document as a parsed JSON object: { Version, Statement: [...] }.
   * Forge stringifies before sending to IAM. CreatePolicy on first apply,
   * CreatePolicyVersion (with SetAsDefault) on subsequent updates if the
   * document drifts. Old non-default versions are pruned to stay under the
   * 5-version-per-policy IAM limit.
   */
  document: object;
}

// ---------------------------------------------------------------------------
// Pinpoint (mobile push / analytics)
// ---------------------------------------------------------------------------

export interface PinpointAppConfig {
  /** Pinpoint application name (used for lookup and create) */
  name: string;
}

// ---------------------------------------------------------------------------
// SecretsManager
// ---------------------------------------------------------------------------

export interface SecretConfig {
  /** Secret name (e.g. 'visible-wealth/aurora-credentials') */
  name: string;
  /** Description (used on update if it differs) */
  description?: string;
  /**
   * Note on secret values:
   *   Forge does NOT capture, log, or modify secret values. They live in AWS only,
   *   set out-of-band (CDK, Console, CLI, rotation). Forge manages metadata only:
   *   name, description, tags. The actual value is owned by whoever set it last.
   */
}

// ---------------------------------------------------------------------------
// KMS
// ---------------------------------------------------------------------------

export interface KmsKeyConfig {
  /**
   * Alias name (without the 'alias/' prefix). Used for lookup and for create.
   * For adopted keys, alias is the stable identifier — physical key IDs (UUIDs)
   * change if a key is rotated/recreated, but aliases survive.
   */
  alias: string;
  /**
   * Existing key ID (UUID) for adoption when no alias is set on the key.
   * Optional — alias-based lookup is preferred.
   */
  keyId?: string;
  /** Description (used on create; updated on existing key if it differs) */
  description?: string;
  /** Enable automatic key rotation (default: true) */
  enableKeyRotation?: boolean;
  /**
   * Note on key policy:
   *   Forge does NOT modify the key policy on adopted keys by default. KMS PutKeyPolicy
   *   is full-replace and a wrong policy can lock everyone out of the key (including the
   *   account root). Treat policy updates as manual operations via AWS Console or CLI.
   *   This may be revisited later with a `policy` field that explicitly opts in.
   */
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
  kms?: KmsKeyConfig[];
  secrets?: SecretConfig[];
  pinpoint?: PinpointAppConfig[];
  managedPolicies?: IamManagedPolicyConfig[];
  securityGroups?: SecurityGroupConfig[];
  lambdaLayers?: LambdaLayerConfig[];
  eventBuses?: EventBusConfig[];
  /** CloudWatch log groups with retention. */
  logGroups?: CloudWatchLogGroupConfig[];
  /** Route 53 hosted zones (and their records). */
  hostedZones?: Route53HostedZoneConfig[];
  /** ACM certificates (DNS validation pairs with hostedZones). */
  certificates?: AcmCertificateConfig[];
  /** VPC endpoints (gateway: s3/dynamodb; interface: ECR / Secrets / etc.). */
  vpcEndpoints?: VpcEndpointConfig[];
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
