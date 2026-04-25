/**
 * API Gateway HTTP API resource module.
 *
 * Creates HTTP APIs with Lambda integrations, JWT authorizers, and routes.
 * Handles the CORS + OPTIONS + JWT authorizer interaction correctly:
 * - CORS handled by API Gateway corsPreflight (not Lambda)
 * - Routes use explicit methods (never ANY — catches OPTIONS and breaks CORS)
 * - Public routes have AuthorizationType: NONE
 * - Catch-all {proxy+} with JWT for authenticated routes
 */

import {
  ApiGatewayV2Client,
  GetApisCommand,
  CreateApiCommand,
  GetIntegrationsCommand,
  CreateIntegrationCommand,
  GetRoutesCommand,
  CreateRouteCommand,
  UpdateRouteCommand,
  GetStagesCommand,
  CreateStageCommand,
  GetAuthorizersCommand,
  CreateAuthorizerCommand,
  UpdateAuthorizerCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  LambdaClient,
  AddPermissionCommand,
  GetPolicyCommand,
} from '@aws-sdk/client-lambda';
import type { AwsContext } from '../aws.js';
import type { ApiGatewayConfig } from '../config.js';
import type { CognitoState } from './cognito.js';
import type { LambdaState } from './lambda.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface ApiGatewayState {
  apiId: string;
  apiEndpoint: string;
  authorizerId?: string;
  routeCount: number;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeApiGateway(
  ctx: AwsContext,
  apiName: string
): Promise<ApiGatewayState | null> {
  const apigw = getClient(ctx, ApiGatewayV2Client);

  const listRes = await apigw.send(new GetApisCommand({}));
  const existing = listRes.Items?.find(a => a.Name === apiName);
  if (!existing) return null;

  const apiId = existing.ApiId!;
  const routesRes = await apigw.send(new GetRoutesCommand({ ApiId: apiId }));
  const authorizersRes = await apigw.send(new GetAuthorizersCommand({ ApiId: apiId }));

  return {
    apiId,
    apiEndpoint: existing.ApiEndpoint!,
    authorizerId: authorizersRes.Items?.[0]?.AuthorizerId,
    routeCount: routesRes.Items?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planApiGateway(
  ctx: AwsContext,
  config: ApiGatewayConfig,
  appName: string,
  plan: Plan
): Promise<ApiGatewayState | null> {
  const apiName = config.name ?? `${appName}-api`;
  const current = await describeApiGateway(ctx, apiName);

  if (current) {
    addChange(plan, {
      resourceType: 'api-gateway',
      resourceId: apiName,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  const publicRoutes = config.publicRoutes ?? [];
  addChange(plan, {
    resourceType: 'api-gateway',
    resourceId: apiName,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'corsOrigins', current: undefined, desired: config.corsOrigins ?? ['*'] },
      { field: 'catchAll', current: undefined, desired: config.catchAll ?? true },
      { field: 'publicRoutes', current: undefined, desired: publicRoutes.length },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyApiGateway(
  ctx: AwsContext,
  config: ApiGatewayConfig,
  appName: string,
  lambdaState: LambdaState,
  cognitoState?: CognitoState
): Promise<ApiGatewayState> {
  const apigw = getClient(ctx, ApiGatewayV2Client);
  const lambdaClient = getClient(ctx, LambdaClient);
  const apiName = config.name ?? `${appName}-api`;

  // --- HTTP API ---
  let apiId: string;
  let apiEndpoint: string;

  const listRes = await apigw.send(new GetApisCommand({}));
  const existing = listRes.Items?.find(a => a.Name === apiName);

  if (existing) {
    apiId = existing.ApiId!;
    apiEndpoint = existing.ApiEndpoint!;
    console.log(`[api-gw] Found: ${apiName} (${apiId})`);
  } else {
    console.log(`[api-gw] Creating HTTP API: ${apiName}`);
    const corsOrigins = config.corsOrigins ?? ['*'];
    const corsMethods = config.corsMethods ?? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

    const createRes = await apigw.send(new CreateApiCommand({
      Name: apiName,
      ProtocolType: 'HTTP',
      CorsConfiguration: {
        AllowOrigins: corsOrigins,
        AllowMethods: corsMethods,
        AllowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
        MaxAge: 86400,
      },
      Tags: { app: appName, 'managed-by': 'forge' },
    }));
    apiId = createRes.ApiId!;
    apiEndpoint = createRes.ApiEndpoint!;
    console.log(`[api-gw] Created: ${apiId} (${apiEndpoint})`);
  }

  // --- Lambda Integration ---
  let integrationId: string;

  const integrationsRes = await apigw.send(new GetIntegrationsCommand({ ApiId: apiId }));
  const existingIntegration = integrationsRes.Items?.find(
    i => i.IntegrationType === 'AWS_PROXY' && i.IntegrationUri === lambdaState.functionArn
  );

  if (existingIntegration) {
    integrationId = existingIntegration.IntegrationId!;
    console.log(`[api-gw] Integration exists: ${integrationId}`);
  } else {
    console.log('[api-gw] Creating Lambda integration');
    const createIntRes = await apigw.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: lambdaState.functionArn,
      IntegrationMethod: 'POST',
      PayloadFormatVersion: '2.0',
    }));
    integrationId = createIntRes.IntegrationId!;
    console.log(`[api-gw] Created integration: ${integrationId}`);
  }

  // --- JWT Authorizer ---
  let authorizerId: string | undefined;

  if (cognitoState) {
    const cognitoPoolId = config.cognitoPoolId ?? cognitoState.userPoolId;
    const cognitoClientId = config.cognitoClientId ?? cognitoState.clients[0]?.clientId;
    const issuer = `https://cognito-idp.${ctx.region}.amazonaws.com/${cognitoPoolId}`;
    const authorizerName = `${appName}-cognito-jwt`;

    const authorizersRes = await apigw.send(new GetAuthorizersCommand({ ApiId: apiId }));
    const existingAuth = authorizersRes.Items?.find(a => a.Name === authorizerName);

    if (existingAuth) {
      authorizerId = existingAuth.AuthorizerId!;
      console.log(`[api-gw] JWT authorizer exists: ${authorizerId}`);

      // Check drift
      if (existingAuth.JwtConfiguration?.Issuer !== issuer) {
        console.log('[api-gw] Updating JWT authorizer issuer');
        await apigw.send(new UpdateAuthorizerCommand({
          ApiId: apiId,
          AuthorizerId: authorizerId,
          Name: authorizerName,
          AuthorizerType: 'JWT',
          IdentitySource: ['$request.header.Authorization'],
          JwtConfiguration: {
            Issuer: issuer,
            Audience: cognitoClientId ? [cognitoClientId] : [],
          },
        }));
      }
    } else {
      console.log(`[api-gw] Creating JWT authorizer: ${authorizerName}`);
      const createAuthRes = await apigw.send(new CreateAuthorizerCommand({
        ApiId: apiId,
        Name: authorizerName,
        AuthorizerType: 'JWT',
        IdentitySource: ['$request.header.Authorization'],
        JwtConfiguration: {
          Issuer: issuer,
          Audience: cognitoClientId ? [cognitoClientId] : [],
        },
      }));
      authorizerId = createAuthRes.AuthorizerId!;
      console.log(`[api-gw] Created JWT authorizer: ${authorizerId}`);
    }
  }

  // --- Routes ---
  const routeTarget = `integrations/${integrationId}`;
  const routesRes = await apigw.send(new GetRoutesCommand({ ApiId: apiId }));
  const existingRoutes = routesRes.Items ?? [];

  // Catch-all with JWT (explicit methods — NEVER use ANY)
  if (config.catchAll !== false && authorizerId) {
    const catchAllMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    for (const method of catchAllMethods) {
      const routeKey = `${method} /{proxy+}`;
      const existingRoute = existingRoutes.find(r => r.RouteKey === routeKey);

      if (existingRoute) {
        if (existingRoute.AuthorizerId !== authorizerId) {
          await apigw.send(new UpdateRouteCommand({
            ApiId: apiId,
            RouteId: existingRoute.RouteId!,
            AuthorizationType: 'JWT',
            AuthorizerId: authorizerId,
            Target: routeTarget,
          }));
        }
      } else {
        await apigw.send(new CreateRouteCommand({
          ApiId: apiId,
          RouteKey: routeKey,
          Target: routeTarget,
          AuthorizationType: 'JWT',
          AuthorizerId: authorizerId,
        }));
      }
    }
    console.log(`[api-gw] Catch-all routes with JWT: ${catchAllMethods.join(', ')} /{proxy+}`);
  }

  // Public routes (no JWT)
  for (const routeKey of config.publicRoutes ?? []) {
    const existingRoute = existingRoutes.find(r => r.RouteKey === routeKey);
    if (!existingRoute) {
      console.log(`[api-gw] Creating public route: ${routeKey}`);
      await apigw.send(new CreateRouteCommand({
        ApiId: apiId,
        RouteKey: routeKey,
        Target: routeTarget,
        AuthorizationType: 'NONE',
      }));
    }
  }

  // --- Stage ---
  const stagesRes = await apigw.send(new GetStagesCommand({ ApiId: apiId }));
  if (!stagesRes.Items?.some(s => s.StageName === '$default')) {
    console.log('[api-gw] Creating $default stage');
    await apigw.send(new CreateStageCommand({
      ApiId: apiId,
      StageName: '$default',
      AutoDeploy: true,
    }));
  }

  // --- Lambda Permission ---
  const accountId = lambdaState.functionArn.split(':')[4];
  const sourceArn = `arn:aws:execute-api:${ctx.region}:${accountId}:${apiId}/*`;
  const statementId = `${appName}-apigw-invoke`;

  try {
    const policy = await lambdaClient.send(new GetPolicyCommand({
      FunctionName: lambdaState.functionName,
    }));
    const policyDoc = JSON.parse(policy.Policy!);
    const hasPermission = policyDoc.Statement?.some((s: any) => s.Sid === statementId);
    if (!hasPermission) throw new Error('need-permission');
  } catch {
    try {
      await lambdaClient.send(new AddPermissionCommand({
        FunctionName: lambdaState.functionArn,
        StatementId: statementId,
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: sourceArn,
      }));
      console.log('[api-gw] Lambda invoke permission added');
    } catch (err: any) {
      if (err.name !== 'ResourceConflictException') throw err;
    }
  }

  const finalRoutes = await apigw.send(new GetRoutesCommand({ ApiId: apiId }));

  return {
    apiId,
    apiEndpoint,
    authorizerId,
    routeCount: finalRoutes.Items?.length ?? 0,
  };
}

export async function destroyApiGateway(
  ctx: AwsContext,
  apiName: string
): Promise<void> {
  const apigw = getClient(ctx, ApiGatewayV2Client);
  const { DeleteApiCommand } = await import('@aws-sdk/client-apigatewayv2');

  const listRes = await apigw.send(new GetApisCommand({}));
  const existing = listRes.Items?.find(a => a.Name === apiName);
  if (!existing) {
    console.log(`[api-gw] ${apiName} not found — nothing to destroy`);
    return;
  }

  console.log(`[api-gw] Deleting API: ${apiName} (${existing.ApiId})`);
  await apigw.send(new DeleteApiCommand({ ApiId: existing.ApiId! }));
  console.log(`[api-gw] Deleted: ${apiName}`);
}
