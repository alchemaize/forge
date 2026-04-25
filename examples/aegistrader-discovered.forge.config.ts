/**
 * aegistrader — Forge config
 *
 * Auto-discovered from live AWS resources (no CloudFormation stack required)
 * Discovered: 2026-04-25
 * Account: 500060134607
 *
 * Review this file before running forge apply.
 * Forge will NOT delete or recreate existing resources — it adopts them in place.
 */

import { defineConfig } from '../src/config.js';

export default defineConfig({
  app: 'aegistrader',
  profile: 'aegis',
  region: 'us-east-1',

  cognito: {
    poolName: 'aegistrader-users',
    emailSignup: true,
    clients: [
      {
        name: 'aegistrader-web',
        authFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_PASSWORD_AUTH'],
        generateSecret: false,
      }
    ],
  },

  dynamodb: [
    {
      name: 'aegistrader-audit',
      pk: 'userId',
      pkType: 'S',
      sk: 'timestamp',
      skType: 'S',
      ttl: 'expiresAt',
    },
    {
      name: 'aegistrader-croccall-positions',
      pk: 'userEmail',
      pkType: 'S',
      sk: 'savedAt',
      skType: 'S',
    },
    {
      name: 'aegistrader-croccall-settings',
      pk: 'userEmail',
      pkType: 'S',
    },
    {
      name: 'aegistrader-croccall-trades',
      pk: 'userEmail',
      pkType: 'S',
      sk: 'timestamp',
      skType: 'S',
      gsi: [
        {
          name: 'weekNumber-index',
          pk: 'weekNumber',
          sk: 'timestamp',
        }
      ],
    },
    {
      name: 'aegistrader-users',
      pk: 'email',
      pkType: 'S',
    },
  ],

  s3: [
    {
      name: 'aegistrader-data-{account}-{region}',
      encryption: 'AES256',
      blockPublicAccess: true,
    },
  ],

  ecr: [
    { name: 'aegistrader', scanOnPush: true },
  ],

  ecsExpress: [
    { name: 'aegistrader' },
  ],
});
