/**
 * API Gateway REST API resource module.
 *
 * Distinct from `api-gateway.ts` which manages HTTP APIs (the v2 product).
 * REST APIs are the v1 product, slower but with more features (request /
 * response transformations, models, validators, usage plans, API keys).
 *
 * Adoption-first design: legacy stacks have REST APIs configured via
 * CDK / Console with hand-tuned mappings. Forge's REST API support is
 * intentionally lighter than the HTTP API support — it adopts existing
 * APIs and lets the user manage resources/methods incrementally.
 *
 * Native create supports:
 *   - REST API itself (regional / edge / private)
 *   - Resources (paths) with parent/child hierarchy from declaration order
 *   - Methods with Lambda integrations (AWS_PROXY)
 *   - Stage deployment
 *
 * Out of scope (defer to Console / CDK / re-import):
 *   - Models + request validators
 *   - Custom domain mappings
 *   - WAF associations (use the waf module's associatedResources)
 *   - Detailed CORS preflight (REST API CORS is awkward; HTTP API is
 *     better for this)
 *
 * SAFETY: Compute-tier — destroy refused (clients break instantly).
 */

import {
  APIGatewayClient,
  GetRestApisCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  CreateResourceCommand,
  PutMethodCommand,
  PutIntegrationCommand,
  CreateDeploymentCommand,
  GetStagesCommand,
} from '@aws-sdk/client-api-gateway';
import {
  LambdaClient,
  AddPermissionCommand,
  GetPolicyCommand,
} from '@aws-sdk/client-lambda';
import type { AwsContext } from '../aws.js';
import type { RestApiConfig } from '../config.js';
import { getClient, withContext, toLambdaArn } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface RestApiState {
  restApiId: string;
  name: string;
  endpointType: string;
  stage?: string;
  resourceCount: number;
  invokeUrl?: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeRestApi(
  ctx: AwsContext,
  config: RestApiConfig
): Promise<RestApiState | null> {
  const apigw: APIGatewayClient = getClient(ctx, APIGatewayClient);
  let position: string | undefined;
  let match: { id?: string; name?: string; endpointConfiguration?: { types?: string[] } } | undefined;
  do {
    const res = await apigw.send(new GetRestApisCommand({ position, limit: 100 }));
    match = res.items?.find(a => a.name === config.name);
    if (match) break;
    position = res.position;
  } while (position);
  if (!match || !match.id) return null;

  const resourcesRes = await apigw.send(new GetResourcesCommand({
    restApiId: match.id,
    limit: 500,
  }));
  const stagesRes = await apigw.send(new GetStagesCommand({ restApiId: match.id }));
  const stage = stagesRes.item?.find(s => s.stageName === (config.stageName ?? 'prod'))?.stageName;
  const invokeUrl = stage
    ? `https://${match.id}.execute-api.${ctx.region}.amazonaws.com/${stage}`
    : undefined;

  return {
    restApiId: match.id,
    name: match.name ?? config.name,
    endpointType: match.endpointConfiguration?.types?.[0] ?? 'REGIONAL',
    stage,
    resourceCount: resourcesRes.items?.length ?? 0,
    invokeUrl,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planRestApi(
  ctx: AwsContext,
  config: RestApiConfig,
  _appName: string,
  plan: Plan
): Promise<RestApiState | null> {
  const current = await describeRestApi(ctx, config);
  const desiredEndpoint = config.endpointType ?? 'REGIONAL';
  const desiredResources = config.resources?.length ?? 0;

  if (!current) {
    addChange(plan, {
      resourceType: 'rest-api',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'endpointType', current: undefined, desired: desiredEndpoint },
        { field: 'resources', current: undefined, desired: desiredResources },
        { field: 'stage', current: undefined, desired: config.stageName ?? 'prod' },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.endpointType !== desiredEndpoint) {
    fields.push({ field: 'endpointType', current: current.endpointType, desired: desiredEndpoint });
  }
  // Resource count is a rough heuristic; a true diff would walk the live
  // resource tree and compare each path. Adoption-first keeps this loose.
  if (desiredResources > 0 && Math.abs(current.resourceCount - desiredResources - 1) > 0) {
    // -1 because every API has an implicit root '/' resource.
    fields.push({
      field: 'resources',
      current: `${current.resourceCount} live`,
      desired: `${desiredResources} configured`,
    });
  }
  addChange(plan, {
    resourceType: 'rest-api',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyRestApi(
  ctx: AwsContext,
  config: RestApiConfig,
  _appName: string
): Promise<RestApiState> {
  const apigw: APIGatewayClient = getClient(ctx, APIGatewayClient);
  const lambdaClient: LambdaClient = getClient(ctx, LambdaClient);
  let current = await describeRestApi(ctx, config);
  let restApiId: string;

  if (!current) {
    console.log(`[rest-api] Creating: ${config.name}`);
    try {
      const res = await apigw.send(new CreateRestApiCommand({
        name: config.name,
        description: config.description,
        endpointConfiguration: {
          types: [config.endpointType ?? 'REGIONAL'],
        },
      }));
      restApiId = res.id!;
    } catch (err) {
      throw withContext(`[rest-api] CreateRestApi ${config.name}`, err);
    }
  } else {
    restApiId = current.restApiId;
  }

  // Build the resource tree. Each entry's path is its full slug; AWS
  // requires a parentId, which we resolve by looking up the parent path
  // in the live resource list.
  if (config.resources?.length) {
    const liveRes = await apigw.send(new GetResourcesCommand({
      restApiId,
      limit: 500,
    }));
    const liveByPath = new Map<string, { id: string; methods: Set<string> }>();
    for (const r of liveRes.items ?? []) {
      liveByPath.set(r.path ?? '/', {
        id: r.id!,
        methods: new Set(Object.keys(r.resourceMethods ?? {})),
      });
    }
    const rootId = liveByPath.get('/')?.id;
    if (!rootId) throw new Error(`[rest-api] no root resource on ${config.name}`);

    for (const desired of config.resources) {
      // Compute the full path. We assume top-level `users` → '/users';
      // nested resources like `users/{id}` should be declared with their
      // full path so parent lookup works.
      const fullPath = desired.path.startsWith('/') ? desired.path : `/${desired.path}`;
      let live = liveByPath.get(fullPath);
      if (!live) {
        // Find the parent path.
        const segments = fullPath.split('/').filter(Boolean);
        const lastSegment = segments[segments.length - 1];
        const parentPath = '/' + segments.slice(0, -1).join('/');
        const parentLive = liveByPath.get(parentPath === '/' ? '/' : parentPath);
        if (!parentLive) {
          throw new Error(`[rest-api] resource '${fullPath}' has no parent at '${parentPath}'. Declare parents before children.`);
        }
        console.log(`[rest-api] Creating resource: ${fullPath}`);
        try {
          const res = await apigw.send(new CreateResourceCommand({
            restApiId,
            parentId: parentLive.id,
            pathPart: lastSegment,
          }));
          live = { id: res.id!, methods: new Set() };
          liveByPath.set(fullPath, live);
        } catch (err) {
          throw withContext(`[rest-api] CreateResource ${fullPath}`, err);
        }
      }

      // Methods.
      for (const method of desired.methods ?? []) {
        if (live.methods.has(method.httpMethod)) continue;
        console.log(`[rest-api] ${fullPath}: adding ${method.httpMethod}`);
        try {
          await apigw.send(new PutMethodCommand({
            restApiId,
            resourceId: live.id,
            httpMethod: method.httpMethod,
            authorizationType: method.authorizationType
              ?? (method.httpMethod === 'OPTIONS' ? 'NONE' : 'AWS_IAM'),
            apiKeyRequired: method.apiKeyRequired ?? false,
          }));
          if (method.targetLambda) {
            const lambdaArn = toLambdaArn(method.targetLambda, ctx.region, ctx.accountId);
            await apigw.send(new PutIntegrationCommand({
              restApiId,
              resourceId: live.id,
              httpMethod: method.httpMethod,
              type: 'AWS_PROXY',
              integrationHttpMethod: 'POST',
              uri: `arn:aws:apigateway:${ctx.region}:lambda:path/2015-03-31/functions/${lambdaArn}/invocations`,
            }));
            // Grant invoke permission idempotently.
            const sid = `restapi-${restApiId}-${method.httpMethod}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            try {
              const policy = await lambdaClient.send(new GetPolicyCommand({ FunctionName: lambdaArn }));
              const policyDoc = JSON.parse(policy.Policy!);
              const has = policyDoc.Statement?.some((s: any) => s.Sid === sid);
              if (has) continue;
            } catch (_err) { /* no policy yet */ }
            await lambdaClient.send(new AddPermissionCommand({
              FunctionName: lambdaArn,
              StatementId: sid,
              Action: 'lambda:InvokeFunction',
              Principal: 'apigateway.amazonaws.com',
              SourceArn: `arn:aws:execute-api:${ctx.region}:${ctx.accountId}:${restApiId}/*/${method.httpMethod}${fullPath}`,
            })).catch((err: any) => {
              if (err.name !== 'ResourceConflictException') throw err;
            });
          }
        } catch (err) {
          throw withContext(`[rest-api] PutMethod ${method.httpMethod} ${fullPath}`, err);
        }
      }
    }

    // Deploy to stage. Each Forge apply creates a new deployment so
    // method changes go live immediately.
    const stageName = config.stageName ?? 'prod';
    console.log(`[rest-api] Creating deployment for stage ${stageName}`);
    try {
      await apigw.send(new CreateDeploymentCommand({
        restApiId,
        stageName,
        description: `Forge deploy ${new Date().toISOString()}`,
      }));
    } catch (err) {
      throw withContext(`[rest-api] CreateDeployment ${stageName}`, err);
    }
  }

  current = (await describeRestApi(ctx, config))!;
  if (current.invokeUrl) {
    console.log(`[rest-api] ${config.name}: ${current.invokeUrl}`);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyRestApi(_ctx: AwsContext, name: string): Promise<never> {
  throw new Error(
    `forge refuses to destroy REST API '${name}'. Clients break the\n` +
    'moment the API ID becomes invalid. Update DNS to point elsewhere first,\n' +
    'wait for caches to expire, then DeleteRestApi via AWS Console or CLI.'
  );
}
