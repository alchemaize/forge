/**
 * AegisTrader — Forge config
 *
 * This replaces aegistrader/scripts/setup-infra.sh with a typed, diffable config.
 * All resources are independently managed. No stack. No cascade deletes.
 *
 * Usage:
 *   cd aegistrader
 *   npx tsx ../forge/src/cli.ts plan --config ../forge/examples/aegistrader.forge.config.ts
 *   npx tsx ../forge/src/cli.ts apply --config ../forge/examples/aegistrader.forge.config.ts
 *   npx tsx ../forge/src/cli.ts status --config ../forge/examples/aegistrader.forge.config.ts
 */

import { defineConfig } from '../src/config.js';

export default defineConfig({
  app: 'aegistrader',
  profile: 'aegis',
  region: 'us-east-1',

  // No VPC needed — ECS Express uses default VPC, DynamoDB is serverless
  // If you ever need a VPC:
  // vpc: { mode: 'lookup', vpcId: 'vpc-xxx' },

  cognito: {
    poolName: 'aegistrader-users',
    emailSignup: true,
    clients: [{
      name: 'aegistrader-web',
      authFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    }],
  },

  dynamodb: [
    { name: 'aegistrader-users', pk: 'email' },
    { name: 'aegistrader-audit', pk: 'userId', sk: 'timestamp', ttl: 'expiresAt' },
    {
      name: 'aegistrader-croccall-trades',
      pk: 'userEmail',
      sk: 'timestamp',
      gsi: [{ name: 'weekNumber-index', pk: 'weekNumber', sk: 'timestamp' }],
    },
    { name: 'aegistrader-croccall-settings', pk: 'userEmail' },
    { name: 'aegistrader-croccall-positions', pk: 'userEmail', sk: 'savedAt' },
  ],

  s3: [{
    name: 'aegistrader-data-{account}-{region}',
    encryption: 'AES256',
    blockPublicAccess: true,
  }],

  ecr: [{
    name: 'aegistrader',
    lifecycleKeep: 5,
    scanOnPush: true,
  }],

  ecsExpress: [{
    name: 'aegistrader',
    cpu: 512,
    memory: 1024,
    port: 8080,
    healthCheckPath: '/health',
    publicIp: true,
  }],
});
