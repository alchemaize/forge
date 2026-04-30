#!/usr/bin/env node
/**
 * Forge CLI
 *
 * Usage:
 *   forge plan                     — show what would change
 *   forge apply                    — create/update resources
 *   forge status                   — show current state
 *   forge destroy <type>:<name>    — tear down a specific resource
 *
 * Config: reads forge.config.ts from current directory.
 */

import { resolve } from 'path';
import { existsSync } from 'fs';

async function loadConfig(configPath: string) {
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error('Create a forge.config.ts in your project directory.');
    process.exit(1);
  }

  // Dynamic import for TypeScript config
  const mod = await import(configPath);
  return mod.default ?? mod.config ?? mod;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Forge — Direct AWS infrastructure management.
No stacks. No state files. No surprises.

Usage:
  forge plan                     Show what would change
  forge apply                    Create/update resources
  forge status                   Show current state of all resources
  forge destroy <type>:<name>    Tear down a specific resource
  forge import                   Import a CloudFormation stack into a forge config
  forge discover                 Discover resources from a live AWS account (no stack needed)
  forge diagram                  Generate an architecture diagram (PNG) from config

Options:
  --config <path>                Config file (default: ./forge.config.ts)
  --confirm-data-loss            Required for destroying data-tier resources
  --landscape                    Diagram orientation (default)
  --portrait                     Diagram in portrait orientation
  --output <path>                Output file path

Import options:
  --stack <name>                 CloudFormation stack name (required)
  --profile <name>               AWS CLI profile (required)
  --region <name>                AWS region (default: us-east-1)
  --output <path>                Output config file path

Discover options:
  --app <name>                   App name prefix to search for (required)
  --profile <name>               AWS CLI profile (required)
  --region <name>                AWS region (default: us-east-1)
  --output <path>                Output config file path

Examples:
  forge plan
  forge apply
  forge status
  forge import --stack YeonCrm --profile yeoncrm
  forge import --stack STRfish --profile strfish --output strfish.forge.config.ts
  forge discover --app aegistrader --profile aegis
  forge diagram --config myapp.forge.config.ts
  forge destroy lambda:my-temp-function
  forge destroy dynamodb:my-table --confirm-data-loss
`);
    process.exit(0);
  }

  // Import command doesn't need a forge config file
  if (command === 'import') {
    const stackIdx = args.indexOf('--stack');
    const profileIdx = args.indexOf('--profile');
    const regionIdx = args.indexOf('--region');
    const outputIdx = args.indexOf('--output');

    if (stackIdx < 0 || profileIdx < 0) {
      console.error('Usage: forge import --stack <name> --profile <name> [--region <name>] [--output <path>]');
      process.exit(1);
    }

    // Accept comma-separated stack names so apps split across multiple CFN stacks
    // (tanaiger has 8, ember has 5+) can be imported into a single forge.config.ts.
    // Resources from each stack are merged before per-resource importers run.
    const importStackNames = args[stackIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
    const importProfile = args[profileIdx + 1];
    const importRegion = regionIdx >= 0 ? args[regionIdx + 1] : 'us-east-1';
    const importOutput = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

    const { importStack: doImport } = await import('./import.js');
    await doImport(importStackNames, importProfile, importRegion, importOutput);
    return;
  }

  // Discover command doesn't need a forge config file either
  if (command === 'discover') {
    const appIdx = args.indexOf('--app');
    const profileIdx = args.indexOf('--profile');
    const regionIdx = args.indexOf('--region');
    const outputIdx = args.indexOf('--output');

    if (appIdx < 0 || profileIdx < 0) {
      console.error('Usage: forge discover --app <name> --profile <name> [--region <name>] [--output <path>]');
      process.exit(1);
    }

    const discoverApp = args[appIdx + 1];
    const discoverProfile = args[profileIdx + 1];
    const discoverRegion = regionIdx >= 0 ? args[regionIdx + 1] : 'us-east-1';
    const discoverOutput = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

    const { discoverApp: doDiscover } = await import('./discover.js');
    await doDiscover(discoverApp, discoverProfile, discoverRegion, discoverOutput);
    return;
  }

  // Find config
  const configFlag = args.indexOf('--config');
  const configPath = configFlag >= 0
    ? resolve(args[configFlag + 1])
    : resolve(process.cwd(), 'forge.config.ts');

  const config = await loadConfig(configPath);
  const { plan, apply, status } = await import('./engine.js');

  switch (command) {
    case 'plan':
      await plan(config);
      break;

    case 'apply':
      await apply(config);
      break;

    case 'status':
      await status(config);
      break;

    case 'diagram': {
      const outputIdx2 = args.indexOf('--output');
      const diagramOutput = outputIdx2 >= 0 ? args[outputIdx2 + 1] : undefined;
      const orientation = args.includes('--portrait') ? 'portrait' as const : 'landscape' as const;
      const { generateDiagram } = await import('./diagram.js');
      await generateDiagram(config, diagramOutput, orientation);
      break;
    }

    case 'destroy': {
      const target = args[1];
      if (!target || !target.includes(':')) {
        console.error('Usage: forge destroy <type>:<name>');
        console.error('Example: forge destroy lambda:my-temp-function');
        process.exit(1);
      }

      const [resourceType, resourceName] = target.split(':', 2);
      const confirmDataLoss = args.includes('--confirm-data-loss');
      const { initAwsContext } = await import('./aws.js');
      const ctx = await initAwsContext(config);

      // Registry of destroy handlers. Adding a new resource type means one
      // entry here, not a new switch case. Each entry returns a thunk so we
      // can lazy-import the module only when its destroy is invoked.
      const destroyRegistry: Record<string, () => Promise<unknown>> = {
        vpc: async () => (await import('./resources/vpc.js')).destroyVpc(),
        rds: async () => (await import('./resources/rds.js')).destroyRds(),
        cognito: async () => (await import('./resources/cognito.js')).destroyCognito(),
        lambda: async () => (await import('./resources/lambda.js')).destroyLambda(ctx, resourceName),
        'api-gateway': async () => (await import('./resources/api-gateway.js')).destroyApiGateway(ctx, resourceName),
        dynamodb: async () => (await import('./resources/dynamodb.js')).destroyDynamoTable(ctx, resourceName, confirmDataLoss),
        s3: async () => (await import('./resources/s3.js')).destroyS3Bucket(ctx, resourceName, confirmDataLoss),
        sqs: async () => (await import('./resources/sqs.js')).destroySqs(resourceName),
        kms: async () => (await import('./resources/kms.js')).destroyKms(),
        'secrets-manager': async () => (await import('./resources/secrets-manager.js')).destroySecret(),
        pinpoint: async () => (await import('./resources/pinpoint.js')).destroyPinpoint(),
        'iam-managed-policy': async () => (await import('./resources/iam-managed-policy.js')).destroyManagedPolicy(),
        'security-group': async () => (await import('./resources/security-group.js')).destroySecurityGroup(),
        'lambda-layer': async () => (await import('./resources/lambda-layer.js')).destroyLayer(),
        'event-bus': async () => (await import('./resources/event-bus.js')).destroyEventBus(),
        cloudfront: async () => (await import('./resources/cloudfront.js')).destroyCloudFront(ctx, resourceName),
        'step-functions': async () => (await import('./resources/step-functions.js')).destroyStepFunction(ctx, resourceName),
        elasticache: async () => (await import('./resources/elasticache.js')).destroyElastiCache(),
        ecr: async () => (await import('./resources/ecr.js')).destroyEcr(ctx, resourceName),
        'ecs-express': async () => (await import('./resources/ecs-express.js')).destroyEcsExpress(),
        sns: async () => (await import('./resources/sns.js')).destroySns(resourceName),
        'log-group': async () => (await import('./resources/cloudwatch.js')).destroyLogGroup(ctx, resourceName, confirmDataLoss),
        alarm: async () => (await import('./resources/cloudwatch.js')).destroyAlarm(ctx, resourceName),
        'route53-zone': async () => (await import('./resources/route53.js')).destroyHostedZone(),
        'acm-certificate': async () => (await import('./resources/acm.js')).destroyAcm(ctx, resourceName),
        eventbridge: async () => (await import('./resources/eventbridge.js')).destroyEventBridge(ctx, resourceName),
        'vpc-endpoint': async () => (await import('./resources/vpc-endpoint.js')).destroyVpcEndpoint(ctx, resourceName),
        'ssm-parameter': async () => (await import('./resources/ssm.js')).destroySsmParameter(ctx, resourceName),
        alb: async () => (await import('./resources/alb.js')).destroyAlb(ctx, resourceName),
        'ecs-cluster': async () => (await import('./resources/ecs.js')).destroyEcsCluster(),
        'ecs-service': async () => (await import('./resources/ecs.js')).destroyEcsService(),
        'web-acl': async () => (await import('./resources/waf.js')).destroyWebAcl(),
        'iam-user': async () => (await import('./resources/iam.js')).destroyIamUser(ctx, resourceName),
        'iam-group': async () => (await import('./resources/iam.js')).destroyIamGroup(),
        'iam-instance-profile': async () => (await import('./resources/iam.js')).destroyInstanceProfile(),
        'rest-api': async () => (await import('./resources/rest-api.js')).destroyRestApi(ctx, resourceName),
        'launch-template': async () => (await import('./resources/ec2-asg.js')).destroyLaunchTemplate(),
        asg: async () => (await import('./resources/ec2-asg.js')).destroyAsg(),
        'bedrock-throughput': async () => (await import('./resources/bedrock.js')).destroyProvisionedThroughput(),
        'bedrock-guardrail': async () => (await import('./resources/bedrock.js')).destroyGuardrail(),
        'sagemaker-endpoint': async () => (await import('./resources/sagemaker.js')).destroySagemakerEndpoint(),
        'opensearch-domain': async () => (await import('./resources/opensearch.js')).destroyOpenSearchDomain(),
        'glue-database': async () => (await import('./resources/glue-athena.js')).destroyGlueDatabase(),
        'athena-workgroup': async () => (await import('./resources/glue-athena.js')).destroyAthenaWorkgroup(),
      };

      const handler = destroyRegistry[resourceType];
      if (!handler) {
        console.error(`Unknown resource type: ${resourceType}`);
        console.error(`Valid types: ${Object.keys(destroyRegistry).sort().join(', ')}`);
        process.exit(1);
      }

      try {
        await handler();
      } catch (err: any) {
        // Most destroy handlers throw with an actionable message
        // (especially the "refused" tier-1 resources). Print and exit non-zero.
        console.error(err.message);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run forge --help for usage.');
      process.exit(1);
  }
}

main().catch(err => {
  // The error message already carries module-level context like
  // "[lambda] foo: ResourceNotFoundException" because each resource
  // module prefixes its throws with the resource type. The withContext
  // helper in aws.ts adds actionable hints for common SDK failure modes
  // (AccessDenied, ExpiredToken, ThrottlingException, etc.). Print the
  // assembled message; show the stack only with DEBUG=1 set so users
  // get clean output by default.
  console.error(`\nFatal: ${err.message}`);
  if (process.env.DEBUG) {
    console.error('');
    console.error(err.stack);
  }
  process.exit(1);
});
