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
  CreateUserPoolDomainCommand,
  DescribeUserPoolDomainCommand,
  AddCustomAttributesCommand,
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Lambda function name from either a full ARN or a bare name.
 * Used for safe equality checks between AWS's stored value (full ARN) and
 * a user's config value (often just the function name).
 */
function lambdaName(arnOrName: string | undefined): string {
  if (!arnOrName) return '';
  return arnOrName.split(':').pop() ?? arnOrName;
}

/**
 * Convert a function name to a full Lambda ARN.
 * Cognito's UpdateUserPool LambdaConfig fields require ARNs, not bare names.
 */
function toLambdaArn(nameOrArn: string, region: string, accountId: string): string {
  if (nameOrArn.startsWith('arn:')) return nameOrArn;
  return `arn:aws:lambda:${region}:${accountId}:function:${nameOrArn}`;
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
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

    // Missing clients
    const desiredClients = config.clients ?? [{ name: `${appName}-app-client` }];
    for (const dc of desiredClients) {
      if (!current.clients.some(cc => cc.clientName === dc.name)) {
        fields.push({ field: `client:${dc.name}`, current: undefined, desired: 'create' });
      }
    }

    // Trigger drift — applyCognito will touch the pool if any of these differ.
    // Compare by Lambda function name (AWS stores ARNs, configs often have bare names).
    if (config.triggers) {
      const cogClient = getClient(ctx, CognitoIdentityProviderClient);
      const poolDesc = await cogClient.send(
        new DescribeUserPoolCommand({ UserPoolId: current.userPoolId })
      );
      const lc = poolDesc.UserPool?.LambdaConfig ?? {};

      const triggerCompares: Array<[string, string | undefined, string | undefined]> = [
        ['preTokenGeneration', lc.PreTokenGeneration, config.triggers.preTokenGeneration],
        ['postConfirmation', lc.PostConfirmation, config.triggers.postConfirmation],
        ['preSignUp', lc.PreSignUp, config.triggers.preSignUp],
        ['customMessage', lc.CustomMessage, config.triggers.customMessage],
        ['customEmailSender', lc.CustomEmailSender?.LambdaArn, config.triggers.customEmailSender],
      ];

      for (const [name, currentVal, desiredVal] of triggerCompares) {
        if (desiredVal && lambdaName(currentVal) !== lambdaName(desiredVal)) {
          fields.push({
            field: `trigger:${name}`,
            current: lambdaName(currentVal) || '(unset)',
            desired: lambdaName(desiredVal),
          });
        }
      }

      // KMSKeyID is a KMS key ARN, not a Lambda — compare directly without lambdaName().
      if (config.triggers.customSenderKmsKey && lc.KMSKeyID !== config.triggers.customSenderKmsKey) {
        fields.push({
          field: 'trigger:customSenderKmsKey',
          current: lc.KMSKeyID || '(unset)',
          desired: config.triggers.customSenderKmsKey,
        });
      }
    }

    addChange(plan, {
      resourceType: 'cognito',
      resourceId: poolName,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'compute',
      fields,
    });
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

  // Build the password policy + schema once so create + update reuse them.
  const passwordPolicy = config.passwordPolicy ? {
    MinimumLength: config.passwordPolicy.minLength ?? 8,
    RequireLowercase: config.passwordPolicy.requireLowercase ?? true,
    RequireUppercase: config.passwordPolicy.requireUppercase ?? true,
    RequireNumbers: config.passwordPolicy.requireDigits ?? true,
    RequireSymbols: config.passwordPolicy.requireSymbols ?? false,
  } : undefined;

  const customSchema = (config.customAttributes ?? []).map(a => ({
    Name: a.name,
    AttributeDataType: (a.type ?? 'String') as 'String' | 'Number' | 'DateTime' | 'Boolean',
    Mutable: a.mutable ?? true,
    Required: a.required ?? false,
  }));

  if (!existing) {
    console.log(`[cognito] Creating user pool: ${poolName}`);
    const recoveryName = (config.accountRecovery ?? 'EMAIL_ONLY') === 'EMAIL_ONLY'
      ? 'verified_email'
      : (config.accountRecovery ?? 'EMAIL_ONLY') === 'PHONE_ONLY'
        ? 'verified_phone_number'
        : 'verified_email';

    const schema: any[] = [
      { Name: 'email', Required: true, Mutable: true, AttributeDataType: 'String' },
      ...customSchema,
    ];

    const createRes = await client.send(new CreateUserPoolCommand({
      PoolName: poolName,
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
      MfaConfiguration: (config.mfa ?? 'OFF') as any,
      Policies: {
        PasswordPolicy: passwordPolicy ?? {
          MinimumLength: 8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        },
      },
      Schema: schema,
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: recoveryName, Priority: 1 }],
      },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    }));

    const userPoolId = createRes.UserPool!.Id!;
    const userPoolArn = createRes.UserPool!.Arn!;
    console.log(`[cognito] Created: ${userPoolId}`);

    existing = { userPoolId, userPoolArn, clients: [] };
  } else if (customSchema.length > 0) {
    // Existing pool — ADD any custom attributes that aren't already in the pool's schema.
    // Cognito doesn't allow modifying or removing schema attributes once created, so we
    // only add. Capture current attrs first to know what's missing.
    try {
      const desc = await client.send(new DescribeUserPoolCommand({ UserPoolId: existing.userPoolId }));
      const existingAttrNames = new Set(
        (desc.UserPool?.SchemaAttributes ?? []).map(a => a.Name?.replace(/^custom:/, ''))
      );
      const toAdd = customSchema.filter(a => !existingAttrNames.has(a.Name));
      if (toAdd.length > 0) {
        console.log(`[cognito] Adding ${toAdd.length} custom attributes to ${existing.userPoolArn.split('/').pop()}: ${toAdd.map(a => a.Name).join(', ')}`);
        await client.send(new AddCustomAttributesCommand({
          UserPoolId: existing.userPoolId,
          CustomAttributes: toAdd,
        }));
      }
    } catch (err: any) {
      console.log(`[cognito] Warning: could not check/add custom attributes: ${err.message}`);
    }
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

  // Cognito Domain (managed Cognito Hosted UI domain). Most projects have one
  // (CDK creates it via userPool.addDomain). Schema's domainPrefix field carries
  // either the prefix-only form ('myapp-123') or a custom domain ('auth.myapp.com').
  if (config.domainPrefix) {
    let currentDomain: string | undefined;
    try {
      const desc = await client.send(new DescribeUserPoolCommand({ UserPoolId: existing.userPoolId }));
      currentDomain = desc.UserPool?.Domain;
    } catch {
      // ignore — fall through to create
    }
    if (currentDomain !== config.domainPrefix) {
      if (!currentDomain) {
        console.log(`[cognito] Creating Cognito domain: ${config.domainPrefix}`);
        try {
          await client.send(new CreateUserPoolDomainCommand({
            UserPoolId: existing.userPoolId,
            Domain: config.domainPrefix,
          }));
        } catch (err: any) {
          // Domain prefixes must be globally unique within Cognito's regional namespace.
          if (err.name === 'InvalidParameterException' && err.message?.includes('already exists')) {
            console.log(`[cognito] Warning: domain '${config.domainPrefix}' is taken globally — pick a different prefix`);
          } else {
            throw err;
          }
        }
      } else {
        // Existing domain differs from desired. Cognito allows only one domain per pool;
        // changing it requires Delete + Create. Refuse and tell the user.
        console.log(
          `[cognito] Pool has domain '${currentDomain}' but config wants '${config.domainPrefix}'. ` +
          `Cognito doesn't allow renaming a domain — manually delete the old one (DeleteUserPoolDomain) ` +
          `if you really want to switch, then re-run apply.`
        );
      }
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
    // Spread preserves every existing trigger (including CustomEmailSender, KMSKeyID,
    // CustomSMSSender, etc.) so apply never wipes triggers that aren't explicitly
    // managed by config.
    const desiredTriggers = { ...currentTriggers };
    let triggersChanged = false;

    // Compare by Lambda function name to avoid false positives from ARN-vs-name diffs.
    // Send full ARNs in updates because Cognito's LambdaConfig fields require ARNs.
    if (config.triggers.preTokenGeneration &&
        lambdaName(currentTriggers.PreTokenGeneration) !== lambdaName(config.triggers.preTokenGeneration)) {
      desiredTriggers.PreTokenGeneration = toLambdaArn(config.triggers.preTokenGeneration, ctx.region, ctx.accountId);
      triggersChanged = true;
    }
    if (config.triggers.postConfirmation &&
        lambdaName(currentTriggers.PostConfirmation) !== lambdaName(config.triggers.postConfirmation)) {
      desiredTriggers.PostConfirmation = toLambdaArn(config.triggers.postConfirmation, ctx.region, ctx.accountId);
      triggersChanged = true;
    }
    if (config.triggers.preSignUp &&
        lambdaName(currentTriggers.PreSignUp) !== lambdaName(config.triggers.preSignUp)) {
      desiredTriggers.PreSignUp = toLambdaArn(config.triggers.preSignUp, ctx.region, ctx.accountId);
      triggersChanged = true;
    }
    if (config.triggers.customMessage &&
        lambdaName(currentTriggers.CustomMessage) !== lambdaName(config.triggers.customMessage)) {
      desiredTriggers.CustomMessage = toLambdaArn(config.triggers.customMessage, ctx.region, ctx.accountId);
      triggersChanged = true;
    }
    if (config.triggers.customEmailSender) {
      // CustomEmailSender has a nested structure (LambdaArn + LambdaVersion).
      // Default to V1_0 — V2_0 changed the event payload format and isn't backwards-compatible.
      const desiredArn = toLambdaArn(config.triggers.customEmailSender, ctx.region, ctx.accountId);
      const currentArn = currentTriggers.CustomEmailSender?.LambdaArn;
      if (lambdaName(currentArn) !== lambdaName(desiredArn)) {
        desiredTriggers.CustomEmailSender = { LambdaArn: desiredArn, LambdaVersion: 'V1_0' };
        triggersChanged = true;
      }
    }
    if (config.triggers.customSenderKmsKey &&
        currentTriggers.KMSKeyID !== config.triggers.customSenderKmsKey) {
      // KMS key Cognito uses to encrypt verification codes for the CustomEmailSender Lambda.
      // Stored at LambdaConfig.KMSKeyID (sibling to CustomEmailSender, not nested).
      desiredTriggers.KMSKeyID = config.triggers.customSenderKmsKey;
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
        VerificationMessageTemplate: pool.VerificationMessageTemplate,
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

      // Add Lambda invoke permissions for each trigger
      const { LambdaClient, AddPermissionCommand, GetPolicyCommand } = await import('@aws-sdk/client-lambda');
      const lambdaClient = new LambdaClient({ region: ctx.region, credentials: ctx.credentials });
      const poolArn = existing.userPoolArn;

      const triggerFunctions = [
        config.triggers.preTokenGeneration,
        config.triggers.postConfirmation,
        config.triggers.preSignUp,
        config.triggers.customMessage,
        config.triggers.customEmailSender,
      ].filter(Boolean) as string[];

      for (const fnName of triggerFunctions) {
        const statementId = `cognito-trigger-${fnName}`.replace(/[^a-zA-Z0-9_-]/g, '-');
        try {
          // Check if permission already exists
          const policy = await lambdaClient.send(new GetPolicyCommand({ FunctionName: fnName }));
          const policyDoc = JSON.parse(policy.Policy!);
          const hasPermission = policyDoc.Statement?.some(
            (s: any) => s.Principal?.Service === 'cognito-idp.amazonaws.com'
          );
          if (hasPermission) continue;
        } catch {
          // No policy exists — need to add permission
        }

        try {
          await lambdaClient.send(new AddPermissionCommand({
            FunctionName: fnName,
            StatementId: statementId,
            Action: 'lambda:InvokeFunction',
            Principal: 'cognito-idp.amazonaws.com',
            SourceArn: poolArn,
          }));
          console.log(`[cognito] Added invoke permission for trigger: ${fnName}`);
        } catch (err: any) {
          if (err.name !== 'ResourceConflictException') {
            console.log(`[cognito] Warning: could not add permission for ${fnName}: ${err.message}`);
          }
        }
      }
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
