/**
 * ECS Express Mode resource module.
 *
 * The "Express Mode" portion of this file is currently a no-op stub —
 * `aws ecs create-express-gateway-service` isn't a real CLI command,
 * so applyEcsExpress refuses with a clear error. The full-ECS module
 * (CreateService + RegisterTaskDefinition + ALB) lives in ecs.ts.
 *
 * ECR is now in src/resources/ecr.ts; this file re-exports those
 * symbols for back-compat with existing engine + cli imports.
 */

import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import type { AwsContext } from '../aws.js';
import type { EcsExpressConfig } from '../config.js';
import { getClient, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
// Back-compat ECR re-exports. New code should import from './ecr.js'.
export {
  describeEcr,
  planEcr,
  applyEcr,
  destroyEcr,
} from './ecr.js';
import type { EcrState } from './ecr.js';
export type { EcrState };

// ---------------------------------------------------------------------------
// ECS Express Mode
// ---------------------------------------------------------------------------

export interface EcsExpressState {
  serviceName: string;
  serviceArn: string;
  status: string;
}

export async function describeEcsExpress(
  ctx: AwsContext,
  serviceName: string
): Promise<EcsExpressState | null> {
  const ecs = getClient(ctx, ECSClient);

  try {
    const listRes = await ecs.send(new ListServicesCommand({ cluster: 'default' }));
    const matchingArn = listRes.serviceArns?.find(arn => arn.includes(serviceName));
    if (!matchingArn) return null;

    const descRes = await ecs.send(new DescribeServicesCommand({
      cluster: 'default',
      services: [matchingArn],
    }));
    const service = descRes.services?.[0];
    if (!service) return null;

    return {
      serviceName: service.serviceName!,
      serviceArn: service.serviceArn!,
      status: service.status!,
    };
  } catch {
    return null;
  }
}

export async function planEcsExpress(
  ctx: AwsContext,
  config: EcsExpressConfig,
  appName: string,
  plan: Plan
): Promise<EcsExpressState | null> {
  const current = await describeEcsExpress(ctx, config.name);

  if (current) {
    addChange(plan, {
      resourceType: 'ecs-express',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'ecs-express',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'cpu', current: undefined, desired: config.cpu ?? 512 },
      { field: 'memory', current: undefined, desired: config.memory ?? 1024 },
      { field: 'port', current: undefined, desired: config.port ?? 8080 },
      { field: 'healthCheckPath', current: undefined, desired: config.healthCheckPath ?? '/health' },
    ],
  });

  return null;
}

export async function applyEcsExpress(
  ctx: AwsContext,
  config: EcsExpressConfig,
  appName: string,
  ecrState?: EcrState
): Promise<EcsExpressState> {
  const current = await describeEcsExpress(ctx, config.name);

  if (current) {
    console.log(`[ecs-express] Service exists: ${config.name} (${current.status})`);
    return current;
  }

  // The earlier implementation shelled out to `aws ecs create-express-gateway-service`,
  // which is not a real AWS CLI command. ECS doesn't have an "Express Mode service"
  // API at the SDK level; the so-called Express Mode is a managed packaging on top
  // of regular ECS service + Fargate + ALB + autoscaling. Real create requires
  // CreateService + RegisterTaskDefinition + ALB target group, which is on the
  // roadmap as a proper full-ECS module.
  //
  // Until that lands, refuse explicitly so users aren't silently left with a
  // PENDING stub.
  throw new Error(
    `[ecs-express] ${config.name}: native create is not implemented.\n` +
    `Provision the ECS service via Console / CDK / CLI, then re-run 'forge import' to capture it.\n` +
    `A proper full-ECS module (CreateService + RegisterTaskDefinition + ALB) is on the roadmap.`
  );
}

export async function destroyEcsExpress(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy ECS services. Use AWS Console or CLI; ensure target group\n' +
    'and load balancer are detached or destroyed cleanly first.'
  );
}
