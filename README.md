# Forge

Direct AWS infrastructure management. No stacks. No state files. No surprises.

Forge replaces AWS CDK and CloudFormation with a tool that treats each resource as an independent entity. It reads live state from AWS APIs, computes a diff against your config, and applies only what changed. There is no stack abstraction, no state file to corrupt, and no cascade deletes.

## Why

CDK and CloudFormation cause real damage:

- **Stack deletion cascades** — deleting a stack destroys every resource in it, including shared VPCs and databases that other apps depend on.
- **Replace semantics** — `update-user-pool` replaces the entire config. Miss a field and it gets silently wiped. This destroyed Lambda triggers on multiple Cognito pools.
- **State machine hell** — when a deploy fails mid-way, the stack enters `UPDATE_ROLLBACK_FAILED`. Recovery requires manual intervention and deep CloudFormation knowledge.
- **Slow iteration** — a full CDK deploy takes 5-13 minutes. A direct `aws lambda update-function-code` takes 3 seconds.
- **Unreliable asset hashing** — CDK's `NodejsFunction` hashes the entry point file, not its imports. Change a dependency and CDK doesn't detect it.

Forge eliminates all of these by design.

## How It Works

1. **No state file** — AWS APIs are the source of truth. Forge reads live state every time. Can't get out of sync.
2. **No stack** — resources are independent. Destroying one never touches another.
3. **No replace semantics** — Forge always reads current config first, then merges your changes. Never wipes fields you didn't specify.
4. **Explicit destroy only** — you must name the specific resource. No "delete everything."
5. **Plan before apply** — shows exactly what API calls will be made before making them.

## Install

```bash
cd forge
npm install
```

Run via tsx (no build step needed for development):

```bash
npx tsx src/cli.ts --help
```

## Commands

### `forge plan`

Show what would change without making any changes.

```bash
npx tsx src/cli.ts plan --config path/to/forge.config.ts
```

### `forge apply`

Create or update resources to match your config.

```bash
npx tsx src/cli.ts apply --config path/to/forge.config.ts
```

Resources are applied in dependency order:
1. VPC
2. RDS / Aurora
3. DynamoDB, S3, ECR (independent)
4. Cognito
5. Lambda (auto-populates env vars from RDS, Cognito)
6. API Gateway (wires to Lambda + Cognito JWT)
7. ECS Express Mode

### `forge status`

Show the current state of all resources declared in your config.

```bash
npx tsx src/cli.ts status --config path/to/forge.config.ts
```

### `forge import`

Generate a forge config from an existing CloudFormation stack. Reads every resource in the stack, queries live AWS for full details, and produces a complete typed config.

```bash
npx tsx src/cli.ts import --stack YeonCrm --profile yeoncrm
npx tsx src/cli.ts import --stack STRfish --profile strfish --output strfish.forge.config.ts
```

What it does:
- Lists all resources in the CloudFormation stack
- Queries live AWS state for each resource (not just CFN metadata)
- Filters out CDK internal Lambdas (CustomS3AutoDeleteObjects, LogRetention, etc.)
- Redacts secrets (env vars matching `secret`, `password`, `api_key`, `token`)
- Templatizes bucket names (replaces account ID and region with `{account}` and `{region}`)
- Extracts Cognito triggers, API Gateway routes, DynamoDB schemas, S3 lifecycle rules

### `forge discover`

Generate a forge config by scanning a live AWS account. No CloudFormation stack required. Works with CLI-provisioned, console-created, or any other resources.

```bash
npx tsx src/cli.ts discover --app aegistrader --profile aegis
npx tsx src/cli.ts discover --app strfish --profile strfish --output strfish.forge.config.ts
```

Discovery strategy:
- Scans every resource type by name prefix (`{app}-*`)
- Traces connections (Lambda VPC config → VPC, Lambda env vars → RDS/Cognito)
- Queries full config for each discovered resource
- Produces the same typed config as `forge import`

### `forge destroy`

Tear down a specific resource. Safety tiers prevent accidental data loss.

```bash
# Compute-tier resources — normal destroy
npx tsx src/cli.ts destroy lambda:my-temp-function --config forge.config.ts

# Data-tier resources — requires explicit flag
npx tsx src/cli.ts destroy dynamodb:my-table --config forge.config.ts --confirm-data-loss

# VPC, RDS, Cognito — always refused
npx tsx src/cli.ts destroy vpc:my-vpc --config forge.config.ts
# Error: forge refuses to destroy VPC resources.
```

**Safety tiers:**

| Tier | Resources | Destroy behavior |
|------|-----------|-----------------|
| Data (tier 1) | VPC, RDS, Aurora, Cognito | **Always refused** — manual deletion only |
| Data (tier 2) | DynamoDB, S3 | Requires `--confirm-data-loss` flag |
| Compute | Lambda, API Gateway, ECS, ECR | Normal destroy |
| Config | IAM, SSM, EventBridge | Normal destroy |

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
    clients: [{
      name: 'myapp-web',
      authFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    }],
    triggers: {
      preTokenGeneration: 'myapp-pre-token',
      postConfirmation: 'myapp-post-confirm',
    },
  },

  lambda: [{
    name: 'myapp-api',
    runtime: 'nodejs20.x',
    memory: 512,
    timeout: 30,
    vpc: true,
    handler: 'index.handler',
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

## Resource Modules

| Module | What it manages |
|--------|----------------|
| `vpc` | VPC, subnets, NAT gateway, internet gateway, security groups (Lambda → Proxy → RDS chain) |
| `rds` | Aurora Serverless v2, standard RDS, RDS Proxy, parameter groups, Secrets Manager |
| `cognito` | User pools, app clients, identity providers, Lambda triggers |
| `lambda` | Functions, IAM roles, code deployment, VPC placement |
| `api-gateway` | HTTP APIs, routes (explicit methods, never ANY), JWT authorizers, Lambda integrations |
| `dynamodb` | Tables, GSIs, TTL, billing mode |
| `s3` | Buckets, encryption, public access blocks, lifecycle rules, CORS, versioning |
| `ecs-express` | ECS Express Mode services, ECR repositories with lifecycle policies |

## Migration from CDK

The migration is non-destructive. Forge adopts existing resources in place — no deletion, no recreation, no downtime.

**Step 1: Generate a forge config from your CDK stack**

```bash
# If you have a CloudFormation stack:
npx tsx src/cli.ts import --stack MyStack --profile myprofile

# If resources were created via CLI (no stack):
npx tsx src/cli.ts discover --app myapp --profile myprofile
```

**Step 2: Verify the generated config**

Review the output file. Check that all values match your expectations. Fix any `REDACTED` env var values.

**Step 3: Run plan to confirm adoption**

```bash
npx tsx src/cli.ts plan --config myapp.forge.config.ts
```

This should show all resources as "unchanged". If it shows creates, something in the config doesn't match the live state — fix the config.

**Step 4: Stop running `cdk deploy`**

The CDK stack stays in place. It's just CloudFormation metadata at that point. Forge manages the actual resources directly. Use `forge apply` for infrastructure changes and your existing deploy scripts for code updates.

**Step 5 (optional): Clean up the CDK stack**

If you want to remove the CloudFormation stack without destroying resources:

```bash
# Wait until the stack is in a stable state, then:
aws cloudformation delete-stack --stack-name MyStack --retain-resources <resource1> <resource2> ...
```

Use `--retain-resources` to list every resource. CloudFormation releases ownership without deleting anything.

## Key Design Decisions

**API Gateway uses explicit methods, never ANY.** `HttpMethod.ANY` catches OPTIONS preflight requests, which causes the JWT authorizer to reject them with 401, breaking CORS. Forge always creates separate routes for GET, POST, PUT, DELETE, PATCH.

**Cognito updates always read-then-merge.** Before updating a user pool or client, Forge reads the full current config via `describe-user-pool` / `describe-user-pool-client` and includes every field in the update call. This prevents the silent field-wiping bug that affects raw `update-user-pool` calls.

**VPC creates a proper security group chain.** When creating a VPC, Forge sets up Lambda SG → RDS Proxy SG → RDS SG with port 5432 inbound rules. This prevents the "Lambda can't reach the database" issue that happens when CDK's `addProxy` creates a security group without inbound rules.

**Lambda env vars are auto-populated.** If your config includes both Cognito and RDS, Forge automatically injects `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `DB_HOST`, `DB_PORT`, and `DB_NAME` into Lambda environment variables.

## Project Structure

```
forge/
  src/
    cli.ts              CLI entry point
    config.ts           Type definitions and defineConfig helper
    engine.ts           Plan/apply/status orchestration
    diff.ts             Diff computation and colored display
    aws.ts              Shared AWS client factory (profile-aware)
    import.ts           CloudFormation stack → forge config
    discover.ts         Live account scan → forge config
    index.ts            Programmatic API exports
    resources/
      vpc.ts            VPC, subnets, NAT, IGW, security groups
      rds.ts            Aurora Serverless v2, RDS, Proxy
      cognito.ts        User pools, clients, triggers
      lambda.ts         Functions, roles, code deploy
      api-gateway.ts    HTTP APIs, routes, authorizers
      dynamodb.ts       Tables, GSIs, TTL
      s3.ts             Buckets, encryption, lifecycle
      ecs-express.ts    ECS Express Mode, ECR repos
  examples/
    aegistrader.forge.config.ts       Hand-written example (DynamoDB + ECS)
    strfish.forge.config.ts           Hand-written example (full stack)
    aegistrader-discovered.forge.config.ts  Auto-discovered from live account
    strfish-imported.forge.config.ts        Auto-imported from CFN stack
```
