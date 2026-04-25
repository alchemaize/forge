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

  // ECS Express Mode uses create-express-gateway-service
  const { execSync } = await import('child_process');
  const ecrRepo = config.ecrRepo ?? ecrState?.repoUri;
  if (!ecrRepo) {
    throw new Error('ECS Express requires an ECR repo URI. Configure ecr or set ecsExpress.ecrRepo.');
  }

  const image = `${ecrRepo}:latest`;
  const cpu = config.cpu ?? 512;
  const memory = config.memory ?? 1024;
  const port = config.port ?? 8080;
  const healthCheckPath = config.healthCheckPath ?? '/health';

  console.log(`[ecs-express] Creating service: ${config.name}`);
  console.log(`[ecs-express] Image: ${image}, CPU: ${cpu}, Memory: ${memory}`);

  try {
    const result = execSync(
      `aws ecs create-express-gateway-service ` +
      `--service-name '${config.name}' ` +
      `--cpu ${cpu} --memory ${memory} ` +
      `--networking '{"assignPublicIp":"${config.publicIp !== false ? 'ENABLED' : 'DISABLED'}"}' ` +
      `--primary-container '{"image":"${image}","port":${port},"healthCheckPath":"${healthCheckPath}"}' ` +
      `--profile '${ctx.profile}' --region '${ctx.region}' ` +
      `--query 'service.serviceArn' --output text`,
      { encoding: 'utf-8' }
    ).trim();

    console.log(`[ecs-express] Created: ${result}`);
    return {
      serviceName: config.name,
      serviceArn: result,
      status: 'ACTIVE',
    };
  } catch (err: any) {
    console.log(`[ecs-express] Note: Service may need a valid image in ECR first.`);
    console.log(`[ecs-express] Push an image to ${ecrRepo} and re-run forge apply.`);
    return {
      serviceName: config.name,
      serviceArn: 'PENDING',
      status: 'PENDING',
    };
  }
}
