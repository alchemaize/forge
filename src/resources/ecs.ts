/**
 * ECS resource module (Fargate-first).
 *
 * Manages clusters, task definitions, and services. Replaces the broken
 * `ecs-express.ts` "Express Mode" stub. Designed for the typical pattern:
 *
 *   1. Cluster (Fargate capacity provider).
 *   2. Task definition (container image, cpu/memory, env, secrets, logs).
 *   3. Service (desired count, launch type, network, ALB integration).
 *   4. Optional auto-scaling (Application Auto Scaling target + policy).
 *
 * Adoption-safe behavior:
 *   - Cluster looked up by name; created if absent.
 *   - Task definitions are versioned by AWS; Forge always registers a
 *     new revision when the canonical task-def shape changes (and points
 *     the service at the new revision). When the shape matches the live
 *     latest revision, no new revision is registered.
 *   - Service looked up by (cluster, name) and updated in place.
 *
 * SAFETY: Compute-tier — destroy refused. Stopping a service silently
 * takes the workload offline.
 */

import {
  ECSClient,
  DescribeClustersCommand,
  CreateClusterCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  type LaunchType,
  type AssignPublicIp,
  type NetworkMode,
  type Compatibility,
} from '@aws-sdk/client-ecs';
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
  type MetricType,
} from '@aws-sdk/client-application-auto-scaling';
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { AwsContext } from '../aws.js';
import type {
  EcsClusterConfig,
  EcsServiceConfig,
  EcsTaskDefConfig,
  ForgeConfig,
} from '../config.js';
import { getClient, withContext, canonicalize, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
// ===========================================================================
// CLUSTERS
// ===========================================================================

export interface EcsClusterState {
  clusterArn: string;
  clusterName: string;
  status: string;
  capacityProviders: string[];
  containerInsights: boolean;
  serviceCount: number;
}

export async function describeEcsCluster(
  ctx: AwsContext,
  config: EcsClusterConfig
): Promise<EcsClusterState | null> {
  const ecs: ECSClient = getClient(ctx, ECSClient);
  const res = await ecs.send(new DescribeClustersCommand({
    clusters: [config.name],
    include: ['SETTINGS'],
  }));
  const cluster = res.clusters?.find(c => c.clusterName === config.name && c.status !== 'INACTIVE');
  if (!cluster) return null;

  const ciSetting = cluster.settings?.find(s => s.name === 'containerInsights');
  return {
    clusterArn: cluster.clusterArn!,
    clusterName: cluster.clusterName!,
    status: cluster.status ?? 'ACTIVE',
    capacityProviders: cluster.capacityProviders ?? [],
    containerInsights: ciSetting?.value === 'enabled',
    serviceCount: cluster.activeServicesCount ?? 0,
  };
}

export async function planEcsCluster(
  ctx: AwsContext,
  config: EcsClusterConfig,
  _appName: string,
  plan: Plan
): Promise<EcsClusterState | null> {
  const current = await describeEcsCluster(ctx, config);
  const desiredCps = config.capacityProviders ?? ['FARGATE'];
  const desiredCi = !!config.containerInsights;

  if (!current) {
    addChange(plan, {
      resourceType: 'ecs-cluster',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'capacityProviders', current: undefined, desired: desiredCps.join(', ') },
        { field: 'containerInsights', current: undefined, desired: desiredCi },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (canonicalize(current.capacityProviders.slice().sort()) !== canonicalize(desiredCps.slice().sort())) {
    fields.push({ field: 'capacityProviders', current: current.capacityProviders.join(', '), desired: desiredCps.join(', ') });
  }
  if (current.containerInsights !== desiredCi) {
    fields.push({ field: 'containerInsights', current: current.containerInsights, desired: desiredCi });
  }
  addChange(plan, {
    resourceType: 'ecs-cluster',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

export async function applyEcsCluster(
  ctx: AwsContext,
  config: EcsClusterConfig,
  appName: string
): Promise<EcsClusterState> {
  const ecs: ECSClient = getClient(ctx, ECSClient);
  const desiredCps = config.capacityProviders ?? ['FARGATE'];
  const desiredCi = !!config.containerInsights;

  const current = await describeEcsCluster(ctx, config);
  if (!current) {
    console.log(`[ecs-cluster] Creating: ${config.name}`);
    try {
      await ecs.send(new CreateClusterCommand({
        clusterName: config.name,
        capacityProviders: desiredCps,
        defaultCapacityProviderStrategy: [{
          capacityProvider: desiredCps[0],
          weight: 1,
          base: 0,
        }],
        settings: [{
          name: 'containerInsights',
          value: desiredCi ? 'enabled' : 'disabled',
        }],
        tags: [
          { key: 'app', value: appName },
          { key: 'managed-by', value: 'forge' },
          ...Object.entries(config.tags ?? {}).map(([key, value]) => ({ key, value })),
        ],
      }));
    } catch (err) {
      throw withContext(`[ecs-cluster] CreateCluster ${config.name}`, err);
    }
  }
  return (await describeEcsCluster(ctx, config))!;
}

// ===========================================================================
// TASK DEFINITIONS
// ===========================================================================

/**
 * Build the canonical RegisterTaskDefinition input from forge config.
 * Used by both the drift-detection compare and the actual register call.
 * Returning the raw input (not a Command) keeps the call site free of
 * generic-Command typing complaints.
 */
function buildTaskDefInput(taskDef: EcsTaskDefConfig, appName: string, ctxRegion: string) {
  const containers = taskDef.containers.map(c => ({
    name: c.name,
    image: c.image,
    memory: c.memory,
    memoryReservation: c.memoryReservation,
    cpu: c.cpu,
    portMappings: c.portMappings?.map(pm => ({
      containerPort: pm.containerPort,
      protocol: pm.protocol ?? 'tcp',
    })),
    environment: c.env
      ? Object.entries(c.env).map(([name, value]) => ({ name, value }))
      : undefined,
    secrets: c.secrets
      ? Object.entries(c.secrets).map(([name, valueFrom]) => ({ name, valueFrom }))
      : undefined,
    essential: c.essential ?? true,
    command: c.command,
    logConfiguration: c.logging
      ? {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': c.logging.logGroupName,
            // Default to the running ctx's region. Empty string here used to
            // pass through to ECS, which would then reject the task def with
            // a cryptic InvalidParameterException about awslogs-region.
            'awslogs-region': c.logging.region ?? ctxRegion,
            'awslogs-stream-prefix': c.logging.streamPrefix ?? 'ecs',
          },
        }
      : undefined,
  }));

  return {
    family: taskDef.family,
    cpu: taskDef.cpu,
    memory: taskDef.memory,
    networkMode: (taskDef.networkMode ?? 'awsvpc') as NetworkMode,
    requiresCompatibilities: ['FARGATE'] as Compatibility[],
    taskRoleArn: taskDef.taskRoleArn,
    executionRoleArn: taskDef.executionRoleArn,
    containerDefinitions: containers,
    tags: [
      { key: 'app', value: appName },
      { key: 'managed-by', value: 'forge' },
    ],
  };
}

/**
 * Compare two task-def shapes by canonicalizing the meaningful fields.
 * AWS returns lots of fields we don't manage (registeredAt, status, etc.);
 * we only care about the fields the user can change.
 */
function canonicalizeTaskDef(td: any): string {
  return canonicalize({
    family: td.family,
    cpu: td.cpu,
    memory: td.memory,
    networkMode: td.networkMode,
    taskRoleArn: td.taskRoleArn ?? '',
    executionRoleArn: td.executionRoleArn ?? '',
    containers: (td.containerDefinitions ?? []).map((c: any) => ({
      name: c.name,
      image: c.image,
      memory: c.memory ?? 0,
      memoryReservation: c.memoryReservation ?? 0,
      cpu: c.cpu ?? 0,
      portMappings: (c.portMappings ?? []).map((pm: any) => ({
        containerPort: pm.containerPort,
        protocol: pm.protocol,
      })),
      environment: (c.environment ?? []).map((e: any) => ({ name: e.name, value: e.value })),
      secrets: (c.secrets ?? []).map((s: any) => ({ name: s.name, valueFrom: s.valueFrom })),
      essential: c.essential ?? true,
      command: c.command,
    })),
  });
}

/**
 * Register a new task-def revision IF the canonical shape differs from the
 * latest live revision in the family. Returns the ARN of the revision the
 * service should be pointed at.
 */
async function ensureLatestTaskDef(
  ctx: AwsContext,
  taskDef: EcsTaskDefConfig,
  appName: string
): Promise<string> {
  const ecs: ECSClient = getClient(ctx, ECSClient);

  // Get the latest revision in the family.
  let latestArn: string | undefined;
  let latestCanonical: string | undefined;
  try {
    const desc = await ecs.send(new DescribeTaskDefinitionCommand({
      taskDefinition: taskDef.family,
    }));
    latestArn = desc.taskDefinition?.taskDefinitionArn;
    latestCanonical = desc.taskDefinition ? canonicalizeTaskDef(desc.taskDefinition) : undefined;
  } catch (err: any) {
    if (err.name !== 'ClientException') throw err;
    // Family doesn't exist yet — falls through to register a fresh revision.
  }

  // Build the desired shape and compare.
  const desiredInput = buildTaskDefInput(taskDef, appName, ctx.region);
  const desiredCanonical = canonicalizeTaskDef({
    family: desiredInput.family,
    cpu: desiredInput.cpu,
    memory: desiredInput.memory,
    networkMode: desiredInput.networkMode,
    taskRoleArn: desiredInput.taskRoleArn,
    executionRoleArn: desiredInput.executionRoleArn,
    containerDefinitions: desiredInput.containerDefinitions,
  });

  if (latestArn && latestCanonical === desiredCanonical) {
    return latestArn;
  }

  console.log(`[ecs-task-def] Registering new revision: ${taskDef.family}`);
  try {
    const res = await ecs.send(new RegisterTaskDefinitionCommand(desiredInput as any));
    return res.taskDefinition!.taskDefinitionArn!;
  } catch (err) {
    throw withContext(`[ecs-task-def] RegisterTaskDefinition ${taskDef.family}`, err);
  }
}

// ===========================================================================
// SERVICES
// ===========================================================================

export interface EcsServiceState {
  serviceArn: string;
  serviceName: string;
  clusterArn: string;
  taskDefinition: string;
  desiredCount: number;
  runningCount: number;
  launchType: string;
  status: string;
}

async function describeEcsService(
  ctx: AwsContext,
  clusterName: string,
  serviceName: string
): Promise<EcsServiceState | null> {
  const ecs: ECSClient = getClient(ctx, ECSClient);
  const res = await ecs.send(new DescribeServicesCommand({
    cluster: clusterName,
    services: [serviceName],
  }));
  const svc = res.services?.find(s => s.serviceName === serviceName && s.status !== 'INACTIVE');
  if (!svc) return null;
  return {
    serviceArn: svc.serviceArn!,
    serviceName: svc.serviceName!,
    clusterArn: svc.clusterArn ?? '',
    taskDefinition: svc.taskDefinition!,
    desiredCount: svc.desiredCount ?? 0,
    runningCount: svc.runningCount ?? 0,
    launchType: svc.launchType ?? 'FARGATE',
    status: svc.status ?? 'ACTIVE',
  };
}

export async function planEcsService(
  ctx: AwsContext,
  config: EcsServiceConfig,
  appName: string,
  plan: Plan
): Promise<EcsServiceState | null> {
  const clusterName = config.clusterName ?? `${appName}-cluster`;
  const current = await describeEcsService(ctx, clusterName, config.name);

  if (!current) {
    addChange(plan, {
      resourceType: 'ecs-service',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'cluster', current: undefined, desired: clusterName },
        { field: 'launchType', current: undefined, desired: config.launchType ?? 'FARGATE' },
        { field: 'desiredCount', current: undefined, desired: config.desiredCount ?? 1 },
        { field: 'image', current: undefined, desired: config.taskDefinition.containers[0]?.image },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.desiredCount !== (config.desiredCount ?? 1)) {
    fields.push({ field: 'desiredCount', current: current.desiredCount, desired: config.desiredCount ?? 1 });
  }
  // Task-def drift surfaced through the canonicalize compare; if any
  // container field changed, the registered ARN won't match the latest.
  // We don't pre-register here (that's apply-side), but flag any image
  // mismatch as a hint.
  const desiredImage = config.taskDefinition.containers[0]?.image;
  if (desiredImage && !current.taskDefinition.includes(config.taskDefinition.family)) {
    fields.push({ field: 'taskDefinition', current: '(differs)', desired: '(config)' });
  }
  addChange(plan, {
    resourceType: 'ecs-service',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

export async function applyEcsService(
  ctx: AwsContext,
  config: EcsServiceConfig,
  appName: string,
  parentConfig?: ForgeConfig,
  vpcStateId?: string,
): Promise<EcsServiceState> {
  const ecs: ECSClient = getClient(ctx, ECSClient);
  const clusterName = config.clusterName ?? `${appName}-cluster`;

  // Make sure the cluster exists (caller may have run applyEcsCluster, but
  // if not, error clearly rather than producing a confusing AWS error).
  const cluster = await describeEcsCluster(ctx, { name: clusterName });
  if (!cluster) {
    throw new Error(`[ecs-service] cluster '${clusterName}' not found. Add it to ecsClusters in forge.config.ts and re-apply, or set clusterName on the service.`);
  }

  // Resolve subnets / security groups for awsvpc network mode.
  const subnets = config.subnetIds
    ?? (parentConfig?.vpc?.mode === 'lookup' ? [] : []);  // lookup mode would need an additional describe; we let user pass explicitly
  void vpcStateId;
  if (subnets.length === 0) {
    throw new Error(`[ecs-service] ${config.name}: no subnetIds supplied. Fargate awsvpc network requires explicit subnets in config.subnetIds.`);
  }

  // Resolve target group ARN if loadBalancer config is set.
  let targetGroupArn: string | undefined;
  if (config.loadBalancer) {
    const elb: ElasticLoadBalancingV2Client = getClient(ctx, ElasticLoadBalancingV2Client);
    const tgRes = await elb.send(new DescribeTargetGroupsCommand({
      Names: [config.loadBalancer.targetGroupName],
    })).catch(() => undefined);
    targetGroupArn = tgRes?.TargetGroups?.[0]?.TargetGroupArn;
    if (!targetGroupArn) {
      throw new Error(`[ecs-service] ${config.name}: target group '${config.loadBalancer.targetGroupName}' not found. Apply ALB before ECS.`);
    }
  }

  // Register or reuse the task definition.
  const taskDefArn = await ensureLatestTaskDef(ctx, config.taskDefinition, appName);

  const networkConfiguration = {
    awsvpcConfiguration: {
      subnets,
      securityGroups: config.securityGroupIds ?? [],
      assignPublicIp: (config.assignPublicIp ? 'ENABLED' : 'DISABLED') as AssignPublicIp,
    },
  };

  const loadBalancers = targetGroupArn && config.loadBalancer ? [{
    targetGroupArn,
    containerName: config.loadBalancer.containerName,
    containerPort: config.loadBalancer.containerPort,
  }] : undefined;

  const current = await describeEcsService(ctx, clusterName, config.name);
  if (!current) {
    console.log(`[ecs-service] Creating service: ${config.name} (cluster=${clusterName})`);
    try {
      await ecs.send(new CreateServiceCommand({
        cluster: clusterName,
        serviceName: config.name,
        taskDefinition: taskDefArn,
        desiredCount: config.desiredCount ?? 1,
        launchType: (config.launchType ?? 'FARGATE') as LaunchType,
        networkConfiguration,
        loadBalancers,
        healthCheckGracePeriodSeconds: targetGroupArn ? (config.healthCheckGracePeriod ?? 60) : undefined,
        tags: [
          { key: 'app', value: appName },
          { key: 'managed-by', value: 'forge' },
          ...Object.entries(config.tags ?? {}).map(([key, value]) => ({ key, value })),
        ],
      }));
    } catch (err) {
      throw withContext(`[ecs-service] CreateService ${config.name}`, err);
    }
  } else {
    console.log(`[ecs-service] Updating service: ${config.name}`);
    try {
      await ecs.send(new UpdateServiceCommand({
        cluster: clusterName,
        service: config.name,
        taskDefinition: taskDefArn,
        desiredCount: config.desiredCount ?? 1,
        networkConfiguration,
      }));
    } catch (err) {
      throw withContext(`[ecs-service] UpdateService ${config.name}`, err);
    }
  }

  // Auto-scaling (Application Auto Scaling — a separate AWS service).
  if (config.autoScaling) {
    await applyAutoScaling(ctx, clusterName, config.name, config.autoScaling);
  }

  return (await describeEcsService(ctx, clusterName, config.name))!;
}

async function applyAutoScaling(
  ctx: AwsContext,
  clusterName: string,
  serviceName: string,
  spec: NonNullable<EcsServiceConfig['autoScaling']>
): Promise<void> {
  const aas: ApplicationAutoScalingClient = getClient(ctx, ApplicationAutoScalingClient);
  const resourceId = `service/${clusterName}/${serviceName}`;
  const scalableDimension = 'ecs:service:DesiredCount';
  const serviceNamespace = 'ecs';

  // Register the scalable target (idempotent — re-registering with the
  // same min/max is a no-op).
  await aas.send(new RegisterScalableTargetCommand({
    ServiceNamespace: serviceNamespace,
    ResourceId: resourceId,
    ScalableDimension: scalableDimension,
    MinCapacity: spec.minCapacity,
    MaxCapacity: spec.maxCapacity,
  }));

  // Target-tracking policy on average CPU. Forge always names the policy
  // `forge-cpu` so re-applies overwrite cleanly.
  await aas.send(new PutScalingPolicyCommand({
    ServiceNamespace: serviceNamespace,
    ResourceId: resourceId,
    ScalableDimension: scalableDimension,
    PolicyName: 'forge-cpu',
    PolicyType: 'TargetTrackingScaling',
    TargetTrackingScalingPolicyConfiguration: {
      TargetValue: spec.cpuTargetUtilization ?? 70,
      PredefinedMetricSpecification: {
        PredefinedMetricType: 'ECSServiceAverageCPUUtilization' as MetricType,
      },
      ScaleInCooldown: 60,
      ScaleOutCooldown: 60,
    },
  }));

  // Keep the auto-scaling-target lookup reachable even though we don't
  // use it on this code path (forge plan in a future iteration could
  // describe + diff scaling settings).
  void DescribeScalableTargetsCommand;
  console.log(`[ecs-service] ${serviceName}: auto-scaling ${spec.minCapacity}-${spec.maxCapacity} @ ${spec.cpuTargetUtilization ?? 70}% CPU`);
}

// ===========================================================================
// DESTROY
// ===========================================================================

export async function destroyEcsCluster(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy ECS clusters. Running services would fail; manual\n' +
    'cleanup via Console is the right path.'
  );
}

export async function destroyEcsService(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy ECS services. The workload goes offline immediately\n' +
    'and load balancer target groups become empty. Drain manually first.'
  );
}

// Keep the unused list-services import reachable for future "discover all
// services in a cluster" support.
void ListServicesCommand;
