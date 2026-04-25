/**
 * Cognito resource module.
 *
 * CRITICAL: Always reads full current config before updating.
 * Never uses replace semantics — merges changes into existing config.
 * This prevents the field-wiping bug that hit 9 pools on 2026-03-13.
 */

import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  CreateUserPoolCommand,
  UpdateUserPoolCommand,
  ListUserPoolsCommand,
  CreateUserPoolClientCommand,
  ListUserPoolClientsCommand,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
  type ExplicitAuthFlowsType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AwsContext } from '../aws.js';
import type { CognitoConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface CognitoState {
  userPoolId: string;
  userPoolArn: string;
  clients: Array<{ clientId: string; clientName: string }>;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeCognito(
  ctx: AwsContext,
  config: CognitoConfig,
  appName: string
): Promise<CognitoState | null> {
  const client = getClient(ctx, CognitoIdentityProviderClient);
  const poolName = config.poolName ?? `${appName}-user-pool`;

  const listRes = await client.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  const existing = listRes.UserPools?.find(p => p.Name === poolName);
  if (!existing?.Id) return null;

  const userPoolId = existing.Id;
  const desc = await client.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
  const userPoolArn = desc.UserPool?.Arn ?? '';

  // Get clients
  const clientsRes = await client.send(new ListUserPoolClientsCommand({
    UserPoolId: userPoolId,
    MaxResults: 60,
  }));
  const clients = (clientsRes.UserPoolClients ?? []).map(c => ({
    clientId: c.ClientId!,
    clientName: c.ClientName!,
  }));

  return { userPoolId, userPoolArn, clients };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planCognito(
  ctx: AwsContext,
  config: CognitoConfig,
  appName: string,
  plan: Plan
): Promise<CognitoState | null> {
  const current = await describeCognito(ctx, config, appName);
  const poolName = config.poolName ?? `${appName}-user-pool`;

  if (current) {
    // Check for missing clients
    const desiredClients = config.clients ?? [{ name: `${appName}-app-client` }];
    const missingClients = desiredClients.filter(
      dc => !current.clients.some(cc => cc.clientName === dc.name)
    );

    if (missingClients.length > 0) {
      addChange(plan, {
        resourceType: 'cognito',
        resourceId: poolName,
        changeType: 'update',
        tier: 'compute',
        fields: missingClients.map(mc => ({
          field: `client:${mc.name}`,
          current: undefined,
          desired: 'create',
        })),
      });
    } else {
      addChange(plan, {
        resourceType: 'cognito',
        resourceId: poolName,
        changeType: 'unchanged',
        tier: 'compute',
        fields: [],
      });
    }
    return current;
  }

  addChange(plan, {
    resourceType: 'cognito',
    resourceId: poolName,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'poolName', current: undefined, desired: poolName },
      { field: 'emailSignup', current: undefined, desired: config.emailSignup ?? true },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyCognito(
  ctx: AwsContext,
  config: CognitoConfig,
  appName: string
): Promise<CognitoState> {
  const client = getClient(ctx, CognitoIdentityProviderClient);
  const poolName = config.poolName ?? `${appName}-user-pool`;

  let existing = await describeCognito(ctx, config, appName);

  if (!existing) {
    console.log(`[cognito] Creating user pool: ${poolName}`);
    const createRes = await client.send(new CreateUserPoolCommand({
      PoolName: poolName,
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
      MfaConfiguration: 'OFF',
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        },
      },
      Schema: [{
        Name: 'email',
        Required: true,
        Mutable: true,
        AttributeDataType: 'String',
      }],
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }],
      },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    }));

    const userPoolId = createRes.UserPool!.Id!;
    const userPoolArn = createRes.UserPool!.Arn!;
    console.log(`[cognito] Created: ${userPoolId}`);

    existing = { userPoolId, userPoolArn, clients: [] };
  }

  // Ensure clients exist
  const desiredClients = config.clients ?? [{
    name: `${appName}-app-client`,
    authFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
  }];

  for (const dc of desiredClients) {
    const existingClient = existing.clients.find(c => c.clientName === dc.name);

    if (existingClient) {
      // Verify config — READ FULL CONFIG FIRST, then merge
      const desc = await client.send(new DescribeUserPoolClientCommand({
        UserPoolId: existing.userPoolId,
        ClientId: existingClient.clientId,
      }));
      const current = desc.UserPoolClient!;
      const desiredFlows = (dc.authFlows ?? [
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
      ]) as ExplicitAuthFlowsType[];

      const currentFlows = current.ExplicitAuthFlows ?? [];
      const needsUpdate = desiredFlows.some(f => !currentFlows.includes(f));

      if (needsUpdate) {
        console.log(`[cognito] Updating client ${dc.name} auth flows`);
        // MERGE: keep all existing fields, only change what we need
        await client.send(new UpdateUserPoolClientCommand({
          UserPoolId: existing.userPoolId,
          ClientId: existingClient.clientId,
          ClientName: dc.name,
          ExplicitAuthFlows: desiredFlows,
          // Preserve existing fields
          SupportedIdentityProviders: current.SupportedIdentityProviders,
          CallbackURLs: dc.callbackUrls ?? current.CallbackURLs,
          LogoutURLs: dc.logoutUrls ?? current.LogoutURLs,
          AllowedOAuthFlows: current.AllowedOAuthFlows,
          AllowedOAuthScopes: current.AllowedOAuthScopes,
          AllowedOAuthFlowsUserPoolClient: current.AllowedOAuthFlowsUserPoolClient,
          PreventUserExistenceErrors: current.PreventUserExistenceErrors,
          ReadAttributes: current.ReadAttributes,
          WriteAttributes: current.WriteAttributes,
          TokenValidityUnits: current.TokenValidityUnits,
          AccessTokenValidity: current.AccessTokenValidity,
          IdTokenValidity: current.IdTokenValidity,
          RefreshTokenValidity: current.RefreshTokenValidity,
        }));
      } else {
        console.log(`[cognito] Client ${dc.name} — no changes needed`);
      }
    } else {
      console.log(`[cognito] Creating client: ${dc.name}`);
      const createClientRes = await client.send(new CreateUserPoolClientCommand({
        UserPoolId: existing.userPoolId,
        ClientName: dc.name,
        ExplicitAuthFlows: (dc.authFlows ?? [
          'ALLOW_USER_PASSWORD_AUTH',
          'ALLOW_USER_SRP_AUTH',
          'ALLOW_REFRESH_TOKEN_AUTH',
        ]) as ExplicitAuthFlowsType[],
        GenerateSecret: dc.generateSecret ?? false,
        PreventUserExistenceErrors: 'ENABLED',
        SupportedIdentityProviders: dc.supportedProviders ?? ['COGNITO'],
        CallbackURLs: dc.callbackUrls,
        LogoutURLs: dc.logoutUrls,
      }));
      existing.clients.push({
        clientId: createClientRes.UserPoolClient!.ClientId!,
        clientName: dc.name,
      });
    }
  }

  // Set triggers if configured
  if (config.triggers) {
    console.log('[cognito] Reading current pool config for trigger update...');
    const poolDesc = await client.send(new DescribeUserPoolCommand({
      UserPoolId: existing.userPoolId,
    }));
    const pool = poolDesc.UserPool!;

    const currentTriggers = pool.LambdaConfig ?? {};
    const desiredTriggers = { ...currentTriggers };
    let triggersChanged = false;

    if (config.triggers.preTokenGeneration && currentTriggers.PreTokenGeneration !== config.triggers.preTokenGeneration) {
      desiredTriggers.PreTokenGeneration = config.triggers.preTokenGeneration;
      triggersChanged = true;
    }
    if (config.triggers.postConfirmation && currentTriggers.PostConfirmation !== config.triggers.postConfirmation) {
      desiredTriggers.PostConfirmation = config.triggers.postConfirmation;
      triggersChanged = true;
    }
    if (config.triggers.preSignUp && currentTriggers.PreSignUp !== config.triggers.preSignUp) {
      desiredTriggers.PreSignUp = config.triggers.preSignUp;
      triggersChanged = true;
    }

    if (triggersChanged) {
      console.log('[cognito] Updating triggers (preserving all other pool config)');
      // CRITICAL: Read EVERY field and include it in the update
      await client.send(new UpdateUserPoolCommand({
        UserPoolId: existing.userPoolId,
        // Preserve ALL existing config
        Policies: pool.Policies,
        AutoVerifiedAttributes: pool.AutoVerifiedAttributes,
        SmsVerificationMessage: pool.SmsVerificationMessage,
        EmailVerificationMessage: pool.EmailVerificationMessage,
        EmailVerificationSubject: pool.EmailVerificationSubject,
        SmsAuthenticationMessage: pool.SmsAuthenticationMessage,
        MfaConfiguration: pool.MfaConfiguration,
        DeviceConfiguration: pool.DeviceConfiguration,
        EmailConfiguration: pool.EmailConfiguration,
        SmsConfiguration: pool.SmsConfiguration,
        UserPoolTags: pool.UserPoolTags,
        AdminCreateUserConfig: pool.AdminCreateUserConfig,
        UserPoolAddOns: pool.UserPoolAddOns,
        AccountRecoverySetting: pool.AccountRecoverySetting,
        // Apply trigger changes
        LambdaConfig: desiredTriggers,
      }));
      console.log('[cognito] Triggers updated');
    }
  }

  return existing;
}

export async function destroyCognito(): Promise<never> {
  throw new Error(
    'forge refuses to destroy Cognito user pools. User data is irreversible.\n' +
    'To delete a user pool, use the AWS Console or CLI manually.\n' +
    'Ensure no users depend on it first.'
  );
}
