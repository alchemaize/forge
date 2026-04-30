/**
 * ECS Express Mode + ECR resource module.
 *
 * Manages ECR repositories and ECS Express Mode services.
 * Deploy = Docker build → ECR push → update-express-gateway-service.
 */

import {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
} from '@aws-sdk/client-ecr';
import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import type { AwsContext } from '../aws.js';
import type { EcrRepoConfig, EcsExpressConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

// ---------------------------------------------------------------------------
// ECR
// ---------------------------------------------------------------------------

export interface EcrState {
  repoName: string;
  repoUri: string;
  repoArn: string;
}

export async function describeEcr(
  ctx: AwsContext,
  repoName: string
): Promise<EcrState | null> {
  const ecr = getClient(ctx, ECRClient);

  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({
      repositoryNames: [repoName],
    }));
    const repo = res.repositories?.[0];
    if (!repo) return null;
    return {
      repoName: repo.repositoryName!,
      repoUri: repo.repositoryUri!,
      repoArn: repo.repositoryArn!,
    };
  } catch (err: any) {
    if (err.name === 'RepositoryNotFoundException') return null;
    throw err;
  }
}

export async function planEcr(
  ctx: AwsContext,
  config: EcrRepoConfig,
  appName: string,
  plan: Plan
): Promise<EcrState | null> {
  const current = await describeEcr(ctx, config.name);

  if (current) {
    addChange(plan, {
      resourceType: 'ecr',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'ecr',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'lifecycleKeep', current: undefined, desired: config.lifecycleKeep ?? 5 },
      { field: 'scanOnPush', current: undefined, desired: config.scanOnPush ?? true },
    ],
  });

  return null;
}

export async function applyEcr(
  ctx: AwsContext,
  config: EcrRepoConfig,
  appName: string
): Promise<EcrState> {
  const ecr = getClient(ctx, ECRClient);
  const current = await describeEcr(ctx, config.name);

  if (current) {
    console.log(`[ecr] Repository exists: ${config.name}`);
    return current;
  }

  console.log(`[ecr] Creating repository: ${config.name}`);
  const res = await ecr.send(new CreateRepositoryCommand({
    repositoryName: config.name,
    imageScanningConfiguration: { scanOnPush: config.scanOnPush ?? true },
    tags: [
      { Key: 'app', Value: appName },
      { Key: 'managed-by', Value: 'forge' },
    ],
  }));

  // Lifecycle policy
  const keepCount = config.lifecycleKeep ?? 5;
  await ecr.send(new PutLifecyclePolicyCommand({
    repositoryName: config.name,
    lifecyclePolicyText: JSON.stringify({
      rules: [{
        rulePriority: 1,
        description: `Keep last ${keepCount} images`,
        selection: {
          tagStatus: 'any',
          countType: 'imageCountMoreThan',
          countNumber: keepCount,
        },
        action: { type: 'expire' },
      }],
    }),
  }));

  const repo = res.repository!;
  console.log(`[ecr] Created: ${repo.repositoryUri}`);

  return {
    repoName: repo.repositoryName!,
    repoUri: repo.repositoryUri!,
    repoArn: repo.repositoryArn!,
  };
}

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

export async function destroyEcr(_ctx: AwsContext, name: string): Promise<never> {
  throw new Error(
    `forge refuses to destroy ECR repository '${name}'. Running ECS / Lambda / App Runner\n` +
    'workloads referencing the image break immediately. Empty + delete via AWS Console.'
  );
}

export async function destroyEcsExpress(): Promise<never> {
  throw new Error(
    'forge refuses to destroy ECS services. Use AWS Console or CLI; ensure target group\n' +
    'and load balancer are detached or destroyed cleanly first.'
  );
}
