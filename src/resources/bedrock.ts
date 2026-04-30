/**
 * Bedrock resource module.
 *
 * Manages Bedrock-specific resources that real AI products need:
 *
 *   1. Provisioned Throughput — committed model capacity at a fixed
 *      hourly rate (cheaper at scale than on-demand). Supports both
 *      no-commit (instant terminate) and 1-month / 6-month commits.
 *
 *   2. Guardrails — content filtering / topic blocking / PII redaction
 *      applied before model input and after model output. Real product
 *      need: hardening AI features against prompt injection + harmful
 *      content + PII leaks.
 *
 *   3. Knowledge Bases — adoption-only today. Multi-step setup involves
 *      S3 sources, vector embeddings (Titan / OpenSearch / Pinecone),
 *      and IAM that's almost always done via Console + capture via
 *      Forge's discover. Native create on the roadmap.
 *
 *   4. Agents — adoption-only. Action groups + KB attachment make
 *      native create complex; usually authored in Bedrock Studio.
 *
 * SAFETY: Compute-tier — destroy refused for provisioned throughputs
 * (committed billing) and adoption-only resources.
 */

import {
  BedrockClient,
  ListProvisionedModelThroughputsCommand,
  GetProvisionedModelThroughputCommand,
  CreateProvisionedModelThroughputCommand,
  ListGuardrailsCommand,
  GetGuardrailCommand,
  CreateGuardrailCommand,
  UpdateGuardrailCommand,
} from '@aws-sdk/client-bedrock';
import type { AwsContext } from '../aws.js';
import type {
  BedrockProvisionedThroughputConfig,
  BedrockGuardrailConfig,
} from '../config.js';
import { getClient, withContext, canonicalize, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
// ===========================================================================
// PROVISIONED THROUGHPUT
// ===========================================================================

export interface ProvisionedThroughputState {
  arn: string;
  name: string;
  modelId: string;
  modelUnits: number;
  status: string;
  commitmentDuration?: string;
}

export async function describeProvisionedThroughput(
  ctx: AwsContext,
  config: BedrockProvisionedThroughputConfig
): Promise<ProvisionedThroughputState | null> {
  const br: BedrockClient = getClient(ctx, BedrockClient);
  let nextToken: string | undefined;
  do {
    const list = await br.send(new ListProvisionedModelThroughputsCommand({
      nextToken,
      maxResults: 100,
    }));
    const match = list.provisionedModelSummaries?.find(p => p.provisionedModelName === config.name);
    if (match) {
      const detail = await br.send(new GetProvisionedModelThroughputCommand({
        provisionedModelId: match.provisionedModelArn,
      }));
      return {
        arn: detail.provisionedModelArn!,
        name: detail.provisionedModelName!,
        modelId: detail.modelArn ?? match.modelArn ?? '',
        modelUnits: detail.modelUnits ?? 0,
        status: detail.status ?? 'Creating',
        commitmentDuration: detail.commitmentDuration,
      };
    }
    nextToken = list.nextToken;
  } while (nextToken);
  return null;
}

export async function planProvisionedThroughput(
  ctx: AwsContext,
  config: BedrockProvisionedThroughputConfig,
  _appName: string,
  plan: Plan
): Promise<ProvisionedThroughputState | null> {
  const current = await describeProvisionedThroughput(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'bedrock-throughput',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'modelId', current: undefined, desired: config.modelId },
        { field: 'modelUnits', current: undefined, desired: config.modelUnits },
        ...(config.commitmentDuration
          ? [{ field: 'commitment', current: undefined, desired: config.commitmentDuration }]
          : []),
      ],
    });
    return null;
  }
  // Provisioned throughput is mostly immutable post-creation; only model
  // units can change (and only at the next billing cycle for committed
  // throughputs). Surface drift but don't auto-apply.
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.modelUnits !== config.modelUnits) {
    fields.push({ field: 'modelUnits', current: current.modelUnits, desired: `${config.modelUnits} (manual change)` });
  }
  addChange(plan, {
    resourceType: 'bedrock-throughput',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

export async function applyProvisionedThroughput(
  ctx: AwsContext,
  config: BedrockProvisionedThroughputConfig,
  _appName: string
): Promise<ProvisionedThroughputState> {
  const br: BedrockClient = getClient(ctx, BedrockClient);
  const current = await describeProvisionedThroughput(ctx, config);
  if (current) {
    console.log(`[bedrock-throughput] Exists: ${config.name} (${current.status})`);
    if (current.modelUnits !== config.modelUnits) {
      console.log(`[bedrock-throughput] Note: modelUnits drift detected (${current.modelUnits} → ${config.modelUnits}). Manual update required via Console (Bedrock doesn't allow programmatic capacity changes mid-commitment).`);
    }
    return current;
  }
  console.log(`[bedrock-throughput] Creating: ${config.name} (${config.modelUnits} units of ${config.modelId})`);
  try {
    const res = await br.send(new CreateProvisionedModelThroughputCommand({
      provisionedModelName: config.name,
      modelId: config.modelId,
      modelUnits: config.modelUnits,
      commitmentDuration: config.commitmentDuration,
    }));
    return {
      arn: res.provisionedModelArn!,
      name: config.name,
      modelId: config.modelId,
      modelUnits: config.modelUnits,
      status: 'Creating',
      commitmentDuration: config.commitmentDuration,
    };
  } catch (err) {
    throw withContext(`[bedrock-throughput] CreateProvisionedModelThroughput ${config.name}`, err);
  }
}

export async function destroyProvisionedThroughput(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy Bedrock provisioned throughputs. Committed\n' +
    'capacity is billed for the full term regardless. Delete via Console\n' +
    'after confirming the commitment date.'
  );
}

// ===========================================================================
// GUARDRAILS
// ===========================================================================

export interface GuardrailState {
  guardrailId: string;
  name: string;
  version: string;
  status: string;
  contentPolicyConfig?: object;
  topicPolicyConfig?: object;
  sensitiveInformationPolicyConfig?: object;
}

export async function describeGuardrail(
  ctx: AwsContext,
  config: BedrockGuardrailConfig
): Promise<GuardrailState | null> {
  const br: BedrockClient = getClient(ctx, BedrockClient);
  let nextToken: string | undefined;
  let match: { id?: string } | undefined;
  do {
    const list = await br.send(new ListGuardrailsCommand({
      nextToken,
      maxResults: 100,
    }));
    match = list.guardrails?.find(g => g.name === config.name);
    if (match) break;
    nextToken = list.nextToken;
  } while (nextToken);
  if (!match || !match.id) return null;

  const detail = await br.send(new GetGuardrailCommand({
    guardrailIdentifier: match.id,
  }));
  return {
    guardrailId: detail.guardrailId!,
    name: detail.name!,
    version: detail.version ?? 'DRAFT',
    status: detail.status ?? 'READY',
    contentPolicyConfig: detail.contentPolicy,
    topicPolicyConfig: detail.topicPolicy,
    sensitiveInformationPolicyConfig: detail.sensitiveInformationPolicy,
  };
}

function buildGuardrailPayload(config: BedrockGuardrailConfig): any {
  const payload: any = {
    name: config.name,
    description: config.description,
    blockedInputMessaging: config.blockedInputMessaging ?? 'Request blocked by content policy.',
    blockedOutputsMessaging: config.blockedOutputsMessaging ?? 'Response blocked by content policy.',
  };
  if (config.contentFilters?.length) {
    payload.contentPolicyConfig = {
      filtersConfig: config.contentFilters.map(f => ({
        type: f.type,
        inputStrength: f.inputStrength ?? 'MEDIUM',
        outputStrength: f.outputStrength ?? 'MEDIUM',
      })),
    };
  }
  if (config.deniedTopics?.length) {
    payload.topicPolicyConfig = {
      topicsConfig: config.deniedTopics.map(t => ({
        name: t.name,
        type: 'DENY',
        definition: t.definition,
        examples: t.examples,
      })),
    };
  }
  if (config.piiEntities?.length) {
    payload.sensitiveInformationPolicyConfig = {
      piiEntitiesConfig: config.piiEntities.map(p => ({
        type: p.type,
        action: p.action,
      })),
    };
  }
  return payload;
}

export async function planGuardrail(
  ctx: AwsContext,
  config: BedrockGuardrailConfig,
  _appName: string,
  plan: Plan
): Promise<GuardrailState | null> {
  const current = await describeGuardrail(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'bedrock-guardrail',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'contentFilters', current: undefined, desired: config.contentFilters?.length ?? 0 },
        { field: 'deniedTopics', current: undefined, desired: config.deniedTopics?.length ?? 0 },
        { field: 'piiEntities', current: undefined, desired: config.piiEntities?.length ?? 0 },
      ],
    });
    return null;
  }
  // Compare canonicalized policy shapes.
  const desired = buildGuardrailPayload(config);
  const liveCanonical = canonicalize({
    contentPolicy: current.contentPolicyConfig,
    topicPolicy: current.topicPolicyConfig,
    sensitiveInformationPolicy: current.sensitiveInformationPolicyConfig,
  });
  const desiredCanonical = canonicalize({
    contentPolicy: desired.contentPolicyConfig,
    topicPolicy: desired.topicPolicyConfig,
    sensitiveInformationPolicy: desired.sensitiveInformationPolicyConfig,
  });
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (liveCanonical !== desiredCanonical) {
    fields.push({ field: 'policy', current: '(differs)', desired: '(config)' });
  }
  addChange(plan, {
    resourceType: 'bedrock-guardrail',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

export async function applyGuardrail(
  ctx: AwsContext,
  config: BedrockGuardrailConfig,
  _appName: string
): Promise<GuardrailState> {
  const br: BedrockClient = getClient(ctx, BedrockClient);
  let current = await describeGuardrail(ctx, config);
  const payload = buildGuardrailPayload(config);

  if (!current) {
    console.log(`[bedrock-guardrail] Creating: ${config.name}`);
    try {
      const res = await br.send(new CreateGuardrailCommand(payload));
      current = {
        guardrailId: res.guardrailId!,
        name: config.name,
        version: res.version ?? 'DRAFT',
        status: 'READY',
        contentPolicyConfig: payload.contentPolicyConfig,
        topicPolicyConfig: payload.topicPolicyConfig,
        sensitiveInformationPolicyConfig: payload.sensitiveInformationPolicyConfig,
      };
    } catch (err) {
      throw withContext(`[bedrock-guardrail] CreateGuardrail ${config.name}`, err);
    }
  } else {
    console.log(`[bedrock-guardrail] Updating: ${config.name}`);
    try {
      await br.send(new UpdateGuardrailCommand({
        guardrailIdentifier: current.guardrailId,
        ...payload,
      }));
    } catch (err) {
      throw withContext(`[bedrock-guardrail] UpdateGuardrail ${config.name}`, err);
    }
  }
  return current;
}

export async function destroyGuardrail(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy Bedrock guardrails. Production AI features\n' +
    'rely on guardrails for safe behavior; deletion silently exposes\n' +
    'unfiltered model output. Detach from agents/applications first.'
  );
}
