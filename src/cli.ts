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

Options:
  --config <path>                Config file (default: ./forge.config.ts)
  --confirm-data-loss            Required for destroying data-tier resources

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

    const importStackName = args[stackIdx + 1];
    const importProfile = args[profileIdx + 1];
    const importRegion = regionIdx >= 0 ? args[regionIdx + 1] : 'us-east-1';
    const importOutput = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

    const { importStack: doImport } = await import('./import.js');
    await doImport(importStackName, importProfile, importRegion, importOutput);
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

      switch (resourceType) {
        case 'vpc':
          const { destroyVpc } = await import('./resources/vpc.js');
          await destroyVpc();
          break;
        case 'rds':
          const { destroyRds } = await import('./resources/rds.js');
          await destroyRds();
          break;
        case 'cognito':
          const { destroyCognito } = await import('./resources/cognito.js');
          await destroyCognito();
          break;
        case 'lambda':
          const { destroyLambda } = await import('./resources/lambda.js');
          await destroyLambda(ctx, resourceName);
          break;
        case 'api-gateway':
          const { destroyApiGateway } = await import('./resources/api-gateway.js');
          await destroyApiGateway(ctx, resourceName);
          break;
        case 'dynamodb':
          const { destroyDynamoTable } = await import('./resources/dynamodb.js');
          await destroyDynamoTable(ctx, resourceName, confirmDataLoss);
          break;
        case 's3':
          const { destroyS3Bucket } = await import('./resources/s3.js');
          await destroyS3Bucket(ctx, resourceName, confirmDataLoss);
          break;
        default:
          console.error(`Unknown resource type: ${resourceType}`);
          console.error('Valid types: vpc, rds, cognito, lambda, api-gateway, dynamodb, s3');
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
  console.error(`\nFatal: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
