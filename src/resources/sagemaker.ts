/**
 * Sagemaker endpoints + endpoint configs resource module.
 *
 * Manages real-time inference endpoints. The pattern:
 *   1. Model (created via Studio / SDK out-of-band; we adopt by name)
 *   2. EndpointConfig (versioned wrapper around Model + instance config)
 *   3. Endpoint (long-running HTTPS endpoint serving the EndpointConfig)
 *
 * Forge creates a new EndpointConfig revision when the canonical shape
 * (model name + instance type + count + weight) changes, then UpdateEndpoint
 * to point at the new config. Old configs aren't auto-deleted (they're
 * cheap and useful for rollback).
 *
 * Out of scope (defer to Studio):
 *   - Model creation (multi-step; almost always done via training jobs +
 *     CreateModel via Studio or SDK).
 *   - Multi-variant deployment (canary / A-B). Single-variant is the
 *     common case.
 *   - Auto-scaling on endpoint.
 *
 * SAFETY: Compute-tier — destroy refused (active inference traffic).
 */

import {
  SageMakerClient,
  DescribeEndpointCommand,
  CreateEndpointCommand,
  UpdateEndpointCommand,
  DescribeEndpointConfigCommand,
  CreateEndpointConfigCommand,
} from '@aws-sdk/client-sagemaker';
import type { AwsContext } from '../aws.js';
import type { SagemakerEndpointConfig } from '../config.js';
import { getClient, withContext, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface SagemakerEndpointState {
  name: string;
  arn: string;
  status: string;
  endpointConfigName: string;
  modelName?: string;
  instanceType?: string;
  instanceCount?: number;
}

export async function describeSagemakerEndpoint(
  ctx: AwsContext,
  config: SagemakerEndpointConfig
): Promise<SagemakerEndpointState | null> {
  const sm: SageMakerClient = getClient(ctx, SageMakerClient);
  let endpointDetail;
  try {
    endpointDetail = await sm.send(new DescribeEndpointCommand({ EndpointName: config.name }));
  } catch (err: any) {
    if (err.name === 'ValidationException' && /not found/i.test(err.message ?? '')) return null;
    throw err;
  }
  if (!endpointDetail.EndpointName) return null;

  // Pull config detail (model + instance shape).
  let modelName: string | undefined;
  let instanceType: string | undefined;
  let instanceCount: number | undefined;
  try {
    const cfg = await sm.send(new DescribeEndpointConfigCommand({
      EndpointConfigName: endpointDetail.EndpointConfigName!,
    }));
    const variant = cfg.ProductionVariants?.[0];
    if (variant) {
      modelName = variant.ModelName;
      instanceType = variant.InstanceType;
      instanceCount = variant.InitialInstanceCount;
    }
  } catch (_err) {
    // Endpoint config may have been deleted; rare.
  }

  return {
    name: endpointDetail.EndpointName,
    arn: endpointDetail.EndpointArn!,
    status: endpointDetail.EndpointStatus ?? 'Creating',
    endpointConfigName: endpointDetail.EndpointConfigName!,
    modelName,
    instanceType,
    instanceCount,
  };
}

function buildVariant(config: SagemakerEndpointConfig): any {
  // Returns as `any` because the SDK uses string-literal unions for
  // InstanceType (ml.t2.medium / ml.m5.large / ml.g4dn.xlarge / etc.) and
  // exhaustively listing them isn't worth it. AWS rejects invalid types
  // at apply time with a clear message.
  return {
    VariantName: config.variant?.name ?? 'AllTraffic',
    ModelName: config.modelName,
    InitialInstanceCount: config.variant?.instanceCount ?? 1,
    InstanceType: config.variant?.instanceType ?? 'ml.t2.medium',
    InitialVariantWeight: config.variant?.initialWeight ?? 1,
  };
}

function canonicalizeVariant(variant: any): string {
  return canonicalize({
    modelName: variant.ModelName,
    instanceType: variant.InstanceType,
    instanceCount: variant.InitialInstanceCount,
    weight: variant.InitialVariantWeight,
  });
}

export async function planSagemakerEndpoint(
  ctx: AwsContext,
  config: SagemakerEndpointConfig,
  _appName: string,
  plan: Plan
): Promise<SagemakerEndpointState | null> {
  const current = await describeSagemakerEndpoint(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'sagemaker-endpoint',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'modelName', current: undefined, desired: config.modelName },
        { field: 'instance', current: undefined, desired: `${config.variant?.instanceCount ?? 1}× ${config.variant?.instanceType ?? 'ml.t2.medium'}` },
      ],
    });
    return null;
  }
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.modelName !== config.modelName) {
    fields.push({ field: 'modelName', current: current.modelName, desired: config.modelName });
  }
  if (config.variant?.instanceType && current.instanceType !== config.variant.instanceType) {
    fields.push({ field: 'instanceType', current: current.instanceType, desired: config.variant.instanceType });
  }
  if (config.variant?.instanceCount && current.instanceCount !== config.variant.instanceCount) {
    fields.push({ field: 'instanceCount', current: current.instanceCount, desired: config.variant.instanceCount });
  }
  addChange(plan, {
    resourceType: 'sagemaker-endpoint',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

export async function applySagemakerEndpoint(
  ctx: AwsContext,
  config: SagemakerEndpointConfig,
  appName: string
): Promise<SagemakerEndpointState> {
  const sm: SageMakerClient = getClient(ctx, SageMakerClient);
  const current = await describeSagemakerEndpoint(ctx, config);
  const desiredVariant = buildVariant(config);

  // Generate a new endpoint config name when the variant shape changes.
  // Sagemaker EndpointConfigs are immutable; you create a new one and
  // point the endpoint at it via UpdateEndpoint.
  const variantHash = canonicalizeVariant(desiredVariant).slice(0, 8);
  const newConfigName = config.endpointConfigName
    ?? `${config.name}-config-${Date.now().toString(36)}-${variantHash}`;

  // Check if the existing endpoint config already matches.
  let needNewConfig = !current;
  if (current) {
    try {
      const liveCfg = await sm.send(new DescribeEndpointConfigCommand({
        EndpointConfigName: current.endpointConfigName,
      }));
      const liveVariant = liveCfg.ProductionVariants?.[0];
      if (liveVariant && canonicalizeVariant(liveVariant) === canonicalizeVariant(desiredVariant)) {
        needNewConfig = false;
      } else {
        needNewConfig = true;
      }
    } catch (_err) {
      needNewConfig = true;
    }
  }

  let configNameToUse = current?.endpointConfigName;
  if (needNewConfig) {
    console.log(`[sagemaker-endpoint] Creating endpoint config: ${newConfigName}`);
    try {
      await sm.send(new CreateEndpointConfigCommand({
        EndpointConfigName: newConfigName,
        ProductionVariants: [desiredVariant],
        Tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }));
      configNameToUse = newConfigName;
    } catch (err) {
      throw withContext(`[sagemaker-endpoint] CreateEndpointConfig ${newConfigName}`, err);
    }
  }

  if (!current) {
    console.log(`[sagemaker-endpoint] Creating endpoint: ${config.name}`);
    try {
      await sm.send(new CreateEndpointCommand({
        EndpointName: config.name,
        EndpointConfigName: configNameToUse!,
        Tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }));
    } catch (err) {
      throw withContext(`[sagemaker-endpoint] CreateEndpoint ${config.name}`, err);
    }
  } else if (needNewConfig) {
    console.log(`[sagemaker-endpoint] Updating endpoint: ${config.name} → ${configNameToUse}`);
    try {
      await sm.send(new UpdateEndpointCommand({
        EndpointName: config.name,
        EndpointConfigName: configNameToUse!,
      }));
    } catch (err) {
      throw withContext(`[sagemaker-endpoint] UpdateEndpoint ${config.name}`, err);
    }
  }

  return (await describeSagemakerEndpoint(ctx, config))!;
}

export async function destroySagemakerEndpoint(): Promise<never> {
  throw new Error(
    'forge refuses to destroy Sagemaker endpoints. Inference traffic\n' +
    'fails immediately. Drain traffic first via Route 53 / consumer\n' +
    'changes, then DeleteEndpoint via AWS Console.'
  );
}
