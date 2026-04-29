# Forge

Direct AWS infrastructure management without stacks or state files.

Forge replaces AWS CDK and CloudFormation with a tool that treats each resource as an independent entity. It reads live state from AWS APIs, computes a diff against your config, and applies only what changed. The stack abstraction is gone, so cascade deletes can't happen and there's no state file to keep in sync.

## Why

CDK and CloudFormation cause real damage:

- **Stack deletion cascades.** Deleting a stack destroys every resource in it, including shared VPCs and databases that other apps depend on.
- **Replace semantics.** `update-user-pool` replaces the entire config. Miss a field and it gets silently wiped. This destroyed Lambda triggers on multiple Cognito pools.
- **State machine hell.** When a deploy fails mid-way, the stack enters `UPDATE_ROLLBACK_FAILED`. Recovery requires manual intervention and deep CloudFormation knowledge.
- **Slow iteration.** A full CDK deploy takes 5 to 13 minutes. A direct `aws lambda update-function-code` takes 3 seconds.
- **Unreliable asset hashing.** CDK's `NodejsFunction` hashes the entry point file, not its imports. Change a dependency and CDK doesn't detect it.

Forge avoids all of these by design.

## How It Works

1. **No state file.** AWS APIs are the source of truth. Forge reads live state every time. Can't get out of sync.
2. **No stack.** Resources are independent. Destroying one never touches another.
3. **No replace semantics.** Forge always reads current config first, then merges your changes. Never wipes fields you didn't specify.
4. **Drift detection on every plan.** Forge compares live state field-by-field and only proposes changes for fields that actually differ. A second `forge plan` after `forge apply` always shows "No changes."
5. **Explicit destroy only.** You must name the specific resource. No "delete everything."
6. **Plan before apply.** Shows exactly what API calls will be made before making them.

## Install

Clone the repo and link it globally:

```bash
git clone https://github.com/alchemaize/forge.git
cd forge
npm install
npm link
```

That's it. `forge` is now available as a command from any directory:

```bash
forge --help
forge status --config path/to/forge.config.ts
```

No build step required. The CLI runs TypeScript directly via tsx.

### Updating

```bash
cd forge
git pull
npm install
```

The global `forge` command automatically picks up changes since it's linked to the source directory.

## Commands

### `forge plan`

Show what would change without making any changes.

```bash
forge plan --config path/to/forge.config.ts
```

By default Forge looks for `./forge.config.ts` in the current directory, so the `--config` flag is optional when run from a project root.

### `forge apply`

Create or update resources to match your config.

```bash
forge apply --config path/to/forge.config.ts
```

Resources are applied in dependency order across phases:

1. **Network.** VPC, subnets, NAT, IGW, security groups
2. **Data.** RDS, Aurora, DynamoDB, S3, KMS, Secrets Manager, ECR
3. **Auth.** Cognito user pools, clients, triggers, domains, custom attributes
4. **Compute.** Lambda layers, Lambda functions, IAM roles, function URLs, event source mappings
5. **API.** API Gateway, CloudFront, ECS Express
6. **Config.** EventBridge buses and rules, SQS queues, SNS topics, Step Functions, Pinpoint, IAM managed policies

Each phase logs as `▸ Phase: <name>` so you can see progress in long-running applies.

### `forge status`

Show the current state of all resources declared in your config.

```bash
forge status --config path/to/forge.config.ts
```

### `forge import`

Generate a forge config from one or more CloudFormation stacks. Reads every resource, queries live AWS for full details, and produces a complete typed config.

```bash
# Single stack
forge import --stack YeonCrm --profile yeoncrm

# Multiple stacks merged into one config (comma-separated)
forge import --stack TanaigerApi,TanaigerAuth,TanaigerDb,TanaigerNetworking \
  --profile tanaiger --output forge.config.ts

# With explicit output path
forge import --stack STRfish --profile strfish --output strfish.forge.config.ts
```

What it does:

- Lists all resources in each stack and merges them
- Queries live AWS state for each resource (not just CFN metadata)
- Filters out CDK internal Lambdas (CustomS3AutoDeleteObjects, LogRetention, etc.)
- Redacts secrets (env vars matching `secret`, `password`, `api_key`, `token`)
- Skips writing secret-pattern env vars to disk so credentials stay out of git
- Templatizes bucket names (replaces account ID and region with `{account}` and `{region}`)
- Quotes hyphenated YAML keys correctly (e.g., `'detail-type'`)
- Captures the full resource graph: roleArn, managed policies, named-form inline policies, function URLs, event source mappings, KMS keys, Secrets Manager entries, Pinpoint apps, EventBridge buses, custom Cognito attributes, password policy, MFA, customEmailSender + KMS key, multi-pool configs, RDS clusterId for instance mode

### `forge discover`

Generate a forge config by scanning a live AWS account. No CloudFormation stack required. Works with CLI-provisioned, console-created, or any other resources.

```bash
forge discover --app aegistrader --profile aegis
forge discover --app strfish --profile strfish --output strfish.forge.config.ts
```

Discovery strategy:

- Scans every resource type by name prefix (`{app}-*`)
- Traces connections (Lambda VPC config to VPC, Lambda env vars to RDS/Cognito)
- Queries full config for each discovered resource
- Produces the same typed config as `forge import`

### `forge diagram`

Generate a professional AWS architecture diagram (PNG) from your forge config. Follows the [AWS Architecture Diagram Guidelines](https://aws.amazon.com/architecture/icons/):

- Official AWS icon set via the `diagrams` Python library
- Proper boundary grouping: AWS Cloud → Region → VPC → Public/Private Subnets
- Service scope awareness: S3, Cognito, DynamoDB are regional (outside VPC); Lambda, RDS Proxy, Aurora are VPC-scoped (inside VPC when configured)
- Numbered callouts on data flow edges
- Consistent edge colors: purple=auth, red=API, orange=async, green=deploy, gray=observability
- Large readable fonts (12pt nodes, 16pt clusters, 24pt title) at 200 DPI
- Landscape (default) and portrait orientation

```bash
forge diagram --config myapp.forge.config.ts
forge diagram --config myapp.forge.config.ts --portrait
forge diagram --config myapp.forge.config.ts --output docs/architecture.png
```

Prerequisites:

```bash
pip3 install diagrams
brew install graphviz
```

### `forge destroy`

Tear down a specific resource. Safety tiers prevent accidental data loss.

```bash
# Compute-tier resources, normal destroy
forge destroy lambda:my-temp-function --config forge.config.ts

# Data-tier resources require explicit flag
forge destroy dynamodb:my-table --config forge.config.ts --confirm-data-loss

# VPC, RDS, Cognito, KMS, Lambda Layer are always refused
forge destroy vpc:my-vpc --config forge.config.ts
# Error: forge refuses to destroy VPC resources.
```

**Safety tiers:**

| Tier | Resources | Destroy behavior |
|------|-----------|------------------|
| Data (tier 1) | VPC, RDS, Aurora, Cognito, KMS, Secrets Manager, Lambda Layer, EventBus | Always refused. Manual deletion only. |
| Data (tier 2) | DynamoDB, S3 | Requires `--confirm-data-loss` flag |
| Compute | Lambda, API Gateway, CloudFront, ECS, ECR, Step Functions | Normal destroy |
| Config | IAM, SSM, EventBridge rules, SQS, SNS, Pinpoint, Security Groups, IAM ManagedPolicy | Normal destroy |

## Resource Modules

Forge has create/apply support for every AWS resource type used by the dev workspace's stacks. Each module ships with drift detection, read-then-merge semantics, and adoption-safe behavior.

| Module | What it manages |
|--------|-----------------|
| `vpc` | VPC, subnets, NAT gateway, internet gateway, security groups (Lambda → Proxy → RDS chain) |
| `rds` | Aurora Serverless v2, standard RDS, RDS Proxy, parameter groups, Secrets Manager bootstrap, clusterId override for instance mode |
| `dynamodb` | Tables, GSIs (add via UpdateTable on existing tables, one at a time per AWS limits), TTL, billing mode |
| `s3` | Buckets, encryption, public access blocks, lifecycle rules, CORS, versioning, bucket policies. Skips PutBucketTagging when bucket has `aws:*` system tags |
| `kms` | Customer-managed keys with rotation. Read-only on policy (key policy modifications are refused to avoid lockouts) |
| `secrets-manager` | Read-only adoption. Forge never touches secret values, only catalogs them |
| `pinpoint` | Apps lookup and create. Used for push notification + messaging surfaces |
| `cognito` | User pools, app clients, identity providers, Lambda triggers (preTokenGen, postConfirm, preSignUp, customMessage, customEmailSender, customSenderKmsKey), domain, custom attributes (additive only per AWS), password policy, MFA, multi-pool configs |
| `lambda` | Functions, IAM roles (managed policies + named/flat inline policies, drift-detected via canonicalized JSON), code deployment via zipPath, VPC placement, function URLs (with `FunctionURLAllowPublicAccess` permission), event source mappings (SQS, Kinesis, DynamoDB streams), env merge with REDACTED refusal |
| `lambda-layer` | Layer publish from local zip. Refuses destroy because layer versions referenced by live functions break those functions on next cold start |
| `iam-managed-policy` | Versioned managed policies, prunes old versions automatically |
| `security-group` | Standalone SGs with sourceSg name resolution |
| `api-gateway` | HTTP APIs, routes (explicit methods, never ANY), JWT authorizers (matched by issuer first, name fallback), Lambda integrations |
| `cloudfront` | Distributions with SPA error responses, S3 or custom origin, ACM cert, managed CachePolicy |
| `step-functions` | State machines with auto-created IAM execution role, definition drift detection |
| `sqs` | Queues with redrive policy, visibility timeout, message retention |
| `event-bus` | Custom EventBridge buses (no auto-delete, since rules may be attached) |
| `eventbridge` | Rules and targets attached to default or custom buses |
| `ecs-express` | ECS Express Mode services, ECR repositories with lifecycle policies |

## Configuration

Each app gets a `forge.config.ts` that declares its desired infrastructure:

```typescript
import { defineConfig } from '@alchemaize/forge';

export default defineConfig({
  app: 'myapp',
  profile: 'myprofile',
  region: 'us-east-1',

  vpc: {
    mode: 'lookup',
    vpcId: 'vpc-0abc123',
  },

  rds: {
    mode: 'aurora-serverless-v2',
    engineVersion: '16.4',
    dbName: 'myapp',
    minCapacity: 0.5,
    maxCapacity: 4,
    proxy: true,
  },

  cognito: {
    poolName: 'myapp-users',
    emailSignup: true,
    passwordPolicy: {
      minimumLength: 12,
      requireSymbols: true,
    },
    mfa: 'OPTIONAL',
    customAttributes: [
      { name: 'role', type: 'String', mutable: true },
      { name: 'org_id', type: 'String', mutable: false },
    ],
    domain: { domainPrefix: 'myapp-auth' },
    clients: [{
      name: 'myapp-web',
      authFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    }],
    triggers: {
      preTokenGeneration: 'myapp-pre-token',
      postConfirmation: 'myapp-post-confirm',
      customEmailSender: 'myapp-email-sender',
      customSenderKmsKey: 'arn:aws:kms:us-east-1:123456789012:key/...',
    },
  },

  lambda: [{
    name: 'myapp-api',
    runtime: 'nodejs22.x',
    memory: 512,
    timeout: 30,
    vpc: true,
    handler: 'index.handler',
    functionUrl: { authType: 'NONE' },
    eventSources: [
      { sourceType: 'sqs', sourceArn: 'arn:aws:sqs:us-east-1:...:myapp-jobs' },
    ],
    inlinePolicies: [{
      name: 'BedrockInvoke',
      statements: [{
        Effect: 'Allow',
        Action: ['bedrock:InvokeModel'],
        Resource: '*',
      }],
    }],
  }],

  apiGateway: {
    catchAll: true,
    publicRoutes: ['GET /health', 'POST /auth/signup', 'POST /auth/login'],
  },

  dynamodb: [
    { name: 'myapp-users', pk: 'email' },
    { name: 'myapp-audit', pk: 'userId', sk: 'timestamp', ttl: 'expiresAt' },
  ],

  s3: [{
    name: 'myapp-data-{account}-{region}',
    encryption: 'AES256',
    blockPublicAccess: true,
  }],

  kms: [{ alias: 'alias/myapp-data', rotation: true }],

  secrets: [{ name: 'myapp/api-keys' }],

  eventBuses: [{ name: 'myapp-events' }],

  lambdaLayers: [{
    name: 'myapp-prisma',
    zipPath: './layers/prisma.zip',
    compatibleRuntimes: ['nodejs22.x'],
  }],

  ecr: [{ name: 'myapp', lifecycleKeep: 5 }],

  ecsExpress: [{
    name: 'myapp',
    cpu: 512,
    memory: 1024,
    port: 8080,
    healthCheckPath: '/health',
  }],
});
```

## Multi-Stack Apps

For apps with multiple CDK stacks (network + data + api + frontend), import everything into one Forge config:

```bash
forge import --stack TanaigerApi,TanaigerAuth,TanaigerDb,TanaigerNetworking,TanaigerStorage,TanaigerWebsocket,TanaigerDispatcherTable \
  --profile tanaiger --output forge.config.ts
```

Forge merges all resources into a single config and dedupes by ARN. Per-environment configs are simple too:

```bash
# Production (us-east-1)
forge plan --config ./forge.config.ts

# Dev (us-west-2)
forge plan --config ./forge.dev.config.ts
```

## Migration from CDK

The migration is non-destructive. Forge adopts existing resources in place without deleting or recreating anything, so there's no downtime.

**Step 1: Generate a forge config from your CDK stacks**

```bash
# CloudFormation stacks (one or many)
forge import --stack MyStack --profile myprofile
forge import --stack Stack1,Stack2,Stack3 --profile myprofile

# Resources created via CLI or console (no stack)
forge discover --app myapp --profile myprofile
```

**Step 2: Verify the generated config**

Review the output file. Check that all values match your expectations. Fix any `REDACTED` env var values. The import skips secret-pattern env vars by design so credentials don't end up in git.

**Step 3: Run plan to confirm adoption**

```bash
forge plan --config myapp.forge.config.ts
```

This should show all resources as "unchanged". If it shows creates, something in the config doesn't match the live state. Fix the config until plan is clean.

**Step 4: Stop running CDK against this app**

The CDK source needs to go somewhere it can't accidentally fire. Common patterns:

- Rename `infra/` to `infra-cdk-archived/` so `cd infra && cdk deploy` fails immediately
- Disable any CI workflow that calls `cdk deploy` (move out of `.github/workflows/` or remove the job)
- Update README and `package.json` scripts to reference `forge plan` / `forge apply`

The CFN stack itself stays in place. It's just metadata at that point. Forge owns the actual resources directly.

**Step 5 (optional): Leave the CFN stack alone**

Orphaned CFN stacks cost $0. AWS doesn't bill for them. The only risk is accidentally running `delete-stack`, which would still trigger the cascade delete of every resource in the template. Don't do that.

If you want to formally retire the stack while keeping resources, the actual workflow is more involved than `--retain-resources`:

1. Edit the deployed template to set `DeletionPolicy: Retain` on every resource you want to keep
2. `aws cloudformation update-stack --template-body ...` with the modified template
3. `aws cloudformation delete-stack`

`delete-stack --retain-resources` only works on resources already in `DELETE_FAILED` state. The simpler answer is to leave the orphaned stack alone.

## Key Design Decisions

**API Gateway uses explicit methods, never ANY.** `HttpMethod.ANY` catches OPTIONS preflight requests, which causes the JWT authorizer to reject them with 401, breaking CORS. Forge always creates separate routes for GET, POST, PUT, DELETE, PATCH.

**Cognito updates always read-then-merge.** Before updating a user pool or client, Forge reads the full current config via `describe-user-pool` / `describe-user-pool-client` and includes every field in the update call. This prevents the silent field-wiping bug that affects raw `update-user-pool` calls.

**JWT authorizers match by issuer, not name.** Different CDK versions name authorizers differently (`cognito-jwt` vs `${app}-cognito-jwt`). Forge matches the existing authorizer by JWT issuer URL first, falling back to name only if no match is found. This avoids spurious creates on adoption.

**VPC creates a proper security group chain.** When creating a VPC, Forge sets up Lambda SG → RDS Proxy SG → RDS SG with port 5432 inbound rules. This prevents the "Lambda can't reach the database" issue that happens when CDK's `addProxy` creates a security group without inbound rules.

**Forge does NOT auto-populate Lambda env vars.** Earlier versions injected `COGNITO_USER_POOL_ID`, `DB_HOST`, etc., but this caused a production incident: a Lambda with `env: {}` (empty object) had its env replaced with the auto-populated set, wiping every secret the Lambda actually needed. Forge now only writes the env you put in `forge.config.ts`. If your Lambda needs database credentials, declare them explicitly. If it needs a Cognito pool ID, declare that too.

**Drift detection on every plan.** Each module reads live state, canonicalizes both sides (sorted keys, normalized JSON), and only proposes changes for fields that actually differ. Running `forge plan` after `forge apply` always shows "No changes" on a stable system.

**Multi-pool Cognito support.** Some apps have several Cognito pools (TxDMV has four: county, dealer, citizen, le-terminal). Import iterates every pool resource. Auto-injection of pool IDs into Lambda env is skipped when multi-pool is detected, since there's no single "the" pool.

**Adoption safety.** No module will recreate a resource on adoption. If a name matches and the resource exists, Forge captures the live state and treats it as managed. The only way to get a `create` plan entry is for the resource to genuinely not exist.

## Project Structure

```
forge/
  src/
    cli.ts              CLI entry point
    config.ts           Type definitions and defineConfig helper
    engine.ts           Plan/apply/status orchestration with phase logging
    diff.ts             Diff computation and colored display
    aws.ts              Shared AWS client factory (profile-aware)
    import.ts           CloudFormation stack(s) → forge config
    discover.ts         Live account scan → forge config
    diagram.ts          Architecture PNG generation
    index.ts            Programmatic API exports
    resources/
      vpc.ts                    VPC, subnets, NAT, IGW, security groups
      rds.ts                    Aurora Serverless v2, RDS, Proxy, clusterId override
      cognito.ts                User pools, clients, triggers, domain, custom attrs, MFA
      lambda.ts                 Functions, roles, code deploy, function URLs, event sources
      lambda-layer.ts           Layer publish from zip
      api-gateway.ts            HTTP APIs, routes, authorizers
      dynamodb.ts               Tables, GSIs (add on existing), TTL
      s3.ts                     Buckets, encryption, lifecycle, bucket policies
      kms.ts                    Customer-managed keys with rotation
      secrets-manager.ts        Read-only secret adoption
      pinpoint.ts               Pinpoint apps lookup and create
      iam-managed-policy.ts     Versioned managed policies with old-version pruning
      security-group.ts         Standalone SGs with sourceSg name resolution
      cloudfront.ts             Distributions with SPA error responses, ACM cert
      step-functions.ts         State machines with auto-created role
      sqs.ts                    Queues with redrive policy
      event-bus.ts              Custom EventBridge buses
      eventbridge.ts            Rules and targets
      ecs-express.ts            ECS Express Mode, ECR repos
  examples/
    aegistrader.forge.config.ts             Hand-written example (DynamoDB + ECS)
    strfish.forge.config.ts                 Hand-written example (full stack)
    aegistrader-discovered.forge.config.ts  Auto-discovered from live account
    strfish-imported.forge.config.ts        Auto-imported from CFN stack
```
