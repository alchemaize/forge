/**
 * STRfish — Forge config
 *
 * Full-stack app: VPC + Aurora Serverless v2 + RDS Proxy + Lambda + API Gateway + Cognito + S3.
 * This is the pattern most apps follow. Replaces the CDK stack `STRfish`.
 *
 * Usage:
 *   npx tsx ../forge/src/cli.ts plan --config ../forge/examples/strfish.forge.config.ts
 *   npx tsx ../forge/src/cli.ts apply --config ../forge/examples/strfish.forge.config.ts
 */

import { defineConfig } from '../src/config.js';

export default defineConfig({
  app: 'strfish',
  profile: 'strfish',
  region: 'us-east-1',

  vpc: {
    mode: 'lookup',
    vpcId: 'vpc-0daf92af1ac4ec9cc',
  },

  rds: {
    mode: 'aurora-serverless-v2',
    engineVersion: '16.4',
    dbName: 'strfish',
    masterUsername: 'strfish_admin',
    minCapacity: 0.5,
    maxCapacity: 4,
    proxy: true,
    forceSsl: true,
    deletionProtection: false,
    passwordStore: 'secrets-manager',
  },

  cognito: {
    poolName: 'strfish-users',
    emailSignup: true,
    clients: [{
      name: 'strfish-app-client',
      authFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    }],
    triggers: {
      preTokenGeneration: 'strfish-pre-token-generation',
      postConfirmation: 'strfish-post-confirmation',
    },
  },

  lambda: [
    {
      name: 'strfish-api',
      runtime: 'nodejs20.x',
      memory: 512,
      timeout: 30,
      architecture: 'arm64',
      vpc: true,
      handler: 'index.handler',
      policies: [
        'arn:aws:iam::aws:policy/AmazonCognitoPowerUser',
      ],
      inlinePolicies: [{
        effect: 'Allow',
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['arn:aws:secretsmanager:us-east-1:380648616162:secret:strfish/*'],
      }],
    },
    {
      name: 'strfish-pre-token-generation',
      runtime: 'nodejs20.x',
      memory: 128,
      timeout: 5,
      architecture: 'arm64',
      vpc: true,
    },
    {
      name: 'strfish-post-confirmation',
      runtime: 'nodejs20.x',
      memory: 128,
      timeout: 10,
      architecture: 'arm64',
      vpc: true,
    },
  ],

  apiGateway: {
    name: 'strfish-api',
    corsOrigins: ['https://str.fish', 'http://localhost:3000'],
    catchAll: true,
    publicRoutes: [
      'GET /health',
      'POST /auth/signup',
      'POST /auth/verify',
      'POST /auth/login',
      'POST /auth/refresh',
    ],
  },

  s3: [
    {
      name: 'strfish-web-{account}-{region}',
      blockPublicAccess: false, // Public website hosting
    },
    {
      name: 'strfish-documents-{account}-{region}',
      encryption: 'AES256',
      blockPublicAccess: true,
    },
  ],
});
