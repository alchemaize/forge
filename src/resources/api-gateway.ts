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

/**
 * Resolve a route entry to (routeKey, targetLambda). String entries land on
 * the default Lambda; structured entries can name a specific one.
 */
function resolveRoute(
  entry: import('../config.js').ApiGatewayRouteEntry,
  defaultLambdaName: string
): { routeKey: string; targetLambdaName: string } {
  if (typeof entry === 'string') {
    return { routeKey: entry, targetLambdaName: defaultLambdaName };
  }
  return {
    routeKey: entry.routeKey,
    targetLambdaName: entry.targetLambda ?? defaultLambdaName,
  };
}

export async function applyApiGateway(
  ctx: AwsContext,
  config: ApiGatewayConfig,
  appName: string,
  lambdaStates: LambdaState[],
  cognitoState?: CognitoState
): Promise<ApiGatewayState> {
  const apigw = getClient(ctx, ApiGatewayV2Client);
  const lambdaClient = getClient(ctx, LambdaClient);
  const apiName = config.name ?? `${appName}-api`;

  if (lambdaStates.length === 0) {
    throw new Error(`[api-gw] ${apiName}: no Lambda states provided. API Gateway needs at least one Lambda to integrate against.`);
  }
  // Build a name -> state lookup for per-route routing. The first Lambda in
  // the config is the default for routes that don't name a specific target
  // (back-compat with the older single-Lambda config form).
  const lambdaByName = new Map<string, LambdaState>();
  for (const ls of lambdaStates) lambdaByName.set(ls.functionName, ls);
  const defaultLambda = lambdaStates[0];

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

  // --- Lambda Integrations ---
  // Build (or adopt) one integration per Lambda the routes target. We
  // dedupe by Lambda ARN so two routes pointing at the same Lambda share
  // a single integration.
  const integrationsRes = await apigw.send(new GetIntegrationsCommand({ ApiId: apiId }));
  const integrationByLambdaName = new Map<string, string>();

  /** Lazily get-or-create an integration for the given Lambda name. */
  const integrationFor = async (lambdaName: string): Promise<string> => {
    const cached = integrationByLambdaName.get(lambdaName);
    if (cached) return cached;
    const target = lambdaByName.get(lambdaName);
    if (!target) {
      throw new Error(`[api-gw] route references Lambda '${lambdaName}' which isn't in lambdaStates`);
    }
    const existingIntegration = integrationsRes.Items?.find(
      i => i.IntegrationType === 'AWS_PROXY' && i.IntegrationUri === target.functionArn
    );
    let integrationId: string;
    if (existingIntegration) {
      integrationId = existingIntegration.IntegrationId!;
      console.log(`[api-gw] Integration exists for ${lambdaName}: ${integrationId}`);
    } else {
      console.log(`[api-gw] Creating integration for ${lambdaName}`);
      const createIntRes = await apigw.send(new CreateIntegrationCommand({
        ApiId: apiId,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: target.functionArn,
        IntegrationMethod: 'POST',
        PayloadFormatVersion: '2.0',
      }));
      integrationId = createIntRes.IntegrationId!;
      console.log(`[api-gw] Created integration for ${lambdaName}: ${integrationId}`);
    }
    integrationByLambdaName.set(lambdaName, integrationId);
    return integrationId;
  };

  // Default integration (used by the catch-all and any string-form routes).
  const defaultIntegrationId = await integrationFor(defaultLambda.functionName);

  // --- JWT Authorizer ---
  let authorizerId: string | undefined;

  if (cognitoState) {
    const cognitoPoolId = config.cognitoPoolId ?? cognitoState.userPoolId;
    const cognitoClientId = config.cognitoClientId ?? cognitoState.clients[0]?.clientId;
    const issuer = `https://cognito-idp.${ctx.region}.amazonaws.com/${cognitoPoolId}`;
    const authorizerName = `${appName}-cognito-jwt`;

    const authorizersRes = await apigw.send(new GetAuthorizersCommand({ ApiId: apiId }));
    // Match by JWT issuer first (semantic match — works for adopted authorizers regardless
    // of name). Fall back to name match for authorizers Forge created in earlier runs.
    // Adopting an existing authorizer this way avoids creating a duplicate alongside
    // the CDK-named one (visiblewealth had this happen on 2026-04-29 — `cognito-jwt` existed
    // in CDK, Forge created `visiblewealth-cognito-jwt` because it didn't recognize the first).
    const existingAuth =
      authorizersRes.Items?.find(a =>
        a.AuthorizerType === 'JWT' && a.JwtConfiguration?.Issuer === issuer
      )
      ?? authorizersRes.Items?.find(a => a.Name === authorizerName);

    if (existingAuth) {
      authorizerId = existingAuth.AuthorizerId!;
      console.log(`[api-gw] JWT authorizer exists: ${authorizerId} (${existingAuth.Name})`);

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
  const defaultRouteTarget = `integrations/${defaultIntegrationId}`;
  const routesRes = await apigw.send(new GetRoutesCommand({ ApiId: apiId }));
  const existingRoutes = routesRes.Items ?? [];

  // Catch-all with JWT (explicit methods — NEVER use ANY). Always lands on
  // the default Lambda; per-route routing is for explicit publicRoutes /
  // authenticatedRoutes entries.
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
            Target: defaultRouteTarget,
          }));
        }
      } else {
        await apigw.send(new CreateRouteCommand({
          ApiId: apiId,
          RouteKey: routeKey,
          Target: defaultRouteTarget,
          AuthorizationType: 'JWT',
          AuthorizerId: authorizerId,
        }));
      }
    }
    console.log(`[api-gw] Catch-all routes with JWT: ${catchAllMethods.join(', ')} /{proxy+}`);
  }

  // Public routes (no JWT). Each entry can target a specific Lambda.
  for (const entry of config.publicRoutes ?? []) {
    const { routeKey, targetLambdaName } = resolveRoute(entry, defaultLambda.functionName);
    const integrationId = await integrationFor(targetLambdaName);
    const target = `integrations/${integrationId}`;
    const existingRoute = existingRoutes.find(r => r.RouteKey === routeKey);
    if (!existingRoute) {
      console.log(`[api-gw] Creating public route: ${routeKey} -> ${targetLambdaName}`);
      await apigw.send(new CreateRouteCommand({
        ApiId: apiId,
        RouteKey: routeKey,
        Target: target,
        AuthorizationType: 'NONE',
      }));
    } else if (existingRoute.AuthorizationType !== 'NONE' || existingRoute.Target !== target) {
      console.log(`[api-gw] Updating public route: ${routeKey} -> ${targetLambdaName}`);
      await apigw.send(new UpdateRouteCommand({
        ApiId: apiId,
        RouteId: existingRoute.RouteId!,
        AuthorizationType: 'NONE',
        Target: target,
      }));
    }
  }

  // Authenticated routes (require JWT). Each entry can target a specific Lambda.
  for (const entry of config.authenticatedRoutes ?? []) {
    const { routeKey, targetLambdaName } = resolveRoute(entry, defaultLambda.functionName);
    if (!authorizerId) {
      console.log(`[api-gw] Skipping ${routeKey}: no JWT authorizer (Cognito not configured)`);
      continue;
    }
    const integrationId = await integrationFor(targetLambdaName);
    const target = `integrations/${integrationId}`;
    const existingRoute = existingRoutes.find(r => r.RouteKey === routeKey);
    if (!existingRoute) {
      console.log(`[api-gw] Creating authenticated route: ${routeKey} -> ${targetLambdaName}`);
      await apigw.send(new CreateRouteCommand({
        ApiId: apiId,
        RouteKey: routeKey,
        Target: target,
        AuthorizationType: 'JWT',
        AuthorizerId: authorizerId,
      }));
    } else if (
      existingRoute.AuthorizationType !== 'JWT' ||
      existingRoute.AuthorizerId !== authorizerId ||
      existingRoute.Target !== target
    ) {
      console.log(`[api-gw] Updating authenticated route: ${routeKey} -> ${targetLambdaName}`);
      await apigw.send(new UpdateRouteCommand({
        ApiId: apiId,
        RouteId: existingRoute.RouteId!,
        AuthorizationType: 'JWT',
        AuthorizerId: authorizerId,
        Target: target,
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

  // --- Lambda Permissions ---
  // Grant apigateway.amazonaws.com lambda:InvokeFunction for every Lambda
  // we wired into an integration. Earlier this only granted on the
  // hard-coded single Lambda, which broke any per-route routing where the
  // target Lambda differed from the default.
  const accountId = defaultLambda.functionArn.split(':')[4];
  const sourceArn = `arn:aws:execute-api:${ctx.region}:${accountId}:${apiId}/*`;
  const statementId = `${appName}-apigw-invoke`;

  for (const lambdaName of integrationByLambdaName.keys()) {
    const target = lambdaByName.get(lambdaName);
    if (!target) continue;
    try {
      const policy = await lambdaClient.send(new GetPolicyCommand({
        FunctionName: target.functionName,
      }));
      const policyDoc = JSON.parse(policy.Policy!);
      const hasPermission = policyDoc.Statement?.some(
        (s: any) => s.Sid === statementId &&
                    s.Condition?.ArnLike?.['AWS:SourceArn'] === sourceArn
      );
      if (hasPermission) continue;
    } catch {
      // No policy yet — fall through.
    }
    try {
      await lambdaClient.send(new AddPermissionCommand({
        FunctionName: target.functionArn,
        StatementId: statementId,
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: sourceArn,
      }));
      console.log(`[api-gw] Invoke permission added for ${lambdaName}`);
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
