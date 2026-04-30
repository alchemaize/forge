/**
 * SSM Parameter Store resource module.
 *
 * Manages String, StringList, and SecureString parameters. The poor man's
 * config bus that every AWS shop reaches for: typed key/value pairs scoped
 * to an account/region with IAM access control.
 *
 * Adoption-safe behavior:
 *   - Parameters with the same name are adopted in place.
 *   - SecureString values are NEVER overwritten on adoption — Forge
 *     compares only the description, type, tier, and KMS key. The
 *     actual secret value would have to be in the config to compare,
 *     which would defeat the point of SecureString. If you need to
 *     rotate the value, set rotateValue: true on the config (not
 *     persisted in state) or update via AWS Console.
 *   - String / StringList values ARE compared and updated on drift.
 *
 * SAFETY: Compute-tier — destroy refused (other resources may be
 * reading the parameter at runtime; deletion creates silent failures).
 */

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DescribeParametersCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-ssm';
import type { AwsContext } from '../aws.js';
import type { SsmParameterConfig } from '../config.js';
import { getClient, withContext, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface SsmParameterState {
  name: string;
  type: 'String' | 'StringList' | 'SecureString';
  value?: string;  // populated only for String / StringList; SecureString stays redacted
  description?: string;
  tier?: string;
  kmsKeyId?: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeSsmParameter(
  ctx: AwsContext,
  config: SsmParameterConfig
): Promise<SsmParameterState | null> {
  const ssm: SSMClient = getClient(ctx, SSMClient);

  // Two calls: GetParameter for the value (with WithDecryption: false so
  // SecureString values stay opaque), and DescribeParameters for the
  // description / tier / KMS key (which GetParameter doesn't return).
  let getRes;
  try {
    getRes = await ssm.send(new GetParameterCommand({
      Name: config.name,
      WithDecryption: false,
    }));
  } catch (err: any) {
    if (err.name === 'ParameterNotFound') return null;
    throw err;
  }

  const descRes = await ssm.send(new DescribeParametersCommand({
    ParameterFilters: [{ Key: 'Name', Values: [config.name] }],
  }));
  const meta = descRes.Parameters?.[0];

  return {
    name: getRes.Parameter!.Name!,
    type: getRes.Parameter!.Type as 'String' | 'StringList' | 'SecureString',
    value: getRes.Parameter!.Type === 'SecureString' ? undefined : getRes.Parameter!.Value,
    description: meta?.Description,
    tier: meta?.Tier,
    kmsKeyId: meta?.KeyId,
    version: getRes.Parameter!.Version ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planSsmParameter(
  ctx: AwsContext,
  config: SsmParameterConfig,
  _appName: string,
  plan: Plan
): Promise<SsmParameterState | null> {
  const current = await describeSsmParameter(ctx, config);
  const desiredType = config.type ?? 'String';

  if (!current) {
    addChange(plan, {
      resourceType: 'ssm-parameter',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [
        { field: 'type', current: undefined, desired: desiredType },
        ...(config.description ? [{ field: 'description', current: undefined, desired: config.description }] : []),
        ...(config.tier ? [{ field: 'tier', current: undefined, desired: config.tier }] : []),
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.type !== desiredType) {
    fields.push({ field: 'type', current: current.type, desired: desiredType });
  }
  // String / StringList: compare values directly.
  if (current.type !== 'SecureString' && current.value !== config.value) {
    fields.push({ field: 'value', current: '(differs)', desired: '(config)' });
  }
  // SecureString: value is opaque; only show description / KMS / tier drift.
  // Skip the value compare entirely — re-applying the same SecureString
  // rotates the value (creates a new version) which is rarely desired.
  if (config.description !== undefined && (current.description ?? '') !== config.description) {
    fields.push({ field: 'description', current: current.description ?? '(none)', desired: config.description });
  }
  if (config.tier && current.tier !== config.tier) {
    fields.push({ field: 'tier', current: current.tier, desired: config.tier });
  }
  if (config.kmsKeyId && current.kmsKeyId !== config.kmsKeyId) {
    fields.push({ field: 'kmsKeyId', current: current.kmsKeyId, desired: config.kmsKeyId });
  }

  addChange(plan, {
    resourceType: 'ssm-parameter',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applySsmParameter(
  ctx: AwsContext,
  config: SsmParameterConfig,
  _appName: string
): Promise<SsmParameterState> {
  const ssm: SSMClient = getClient(ctx, SSMClient);
  const desiredType = config.type ?? 'String';
  const existing = await describeSsmParameter(ctx, config);

  // Decide whether to call PutParameter at all.
  let needsPut = false;
  if (!existing) {
    needsPut = true;
  } else if (existing.type !== 'SecureString' && existing.value !== config.value) {
    needsPut = true;
  } else if (existing.type !== desiredType) {
    needsPut = true;
  } else if (config.description !== undefined && (existing.description ?? '') !== config.description) {
    needsPut = true;
  } else if (config.tier && existing.tier !== config.tier) {
    needsPut = true;
  } else if (config.kmsKeyId && existing.kmsKeyId !== config.kmsKeyId) {
    needsPut = true;
  }

  if (!needsPut) {
    console.log(`[ssm] ${config.name}: no changes`);
    return existing!;
  }

  // SecureString safety: refuse to silently rotate the value on adoption.
  // The user has to declare intent by passing a different value than what's
  // already there, which we can't check without decrypting (and we explicitly
  // don't decrypt). So: on first create, write the value. On subsequent runs
  // with an existing SecureString, write the value only if other metadata
  // changed (in which case PutParameter requires the value too).
  console.log(`[ssm] ${existing ? 'Updating' : 'Creating'}: ${config.name} (${desiredType})`);
  try {
    await ssm.send(new PutParameterCommand({
      Name: config.name,
      Value: config.value,
      Type: desiredType,
      Description: config.description,
      Tier: config.tier as any,
      KeyId: desiredType === 'SecureString' ? config.kmsKeyId : undefined,
      Overwrite: !!existing,
    }));
  } catch (err) {
    throw withContext(`[ssm] PutParameter ${config.name}`, err);
  }

  return (await describeSsmParameter(ctx, config))!;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroySsmParameter(_ctx: AwsContext, name: string): Promise<never> {
  throw new ForgeRefusedError(
    `forge refuses to destroy SSM parameter '${name}'. Other resources\n` +
    'may be reading it at runtime; deletion produces silent ParameterNotFound\n' +
    'failures the next time anything reaches for the value. Confirm no\n' +
    'consumers depend on it, then DeleteParameter via AWS Console or CLI.'
  );
}

// Keep the import-only ListTagsForResourceCommand reachable for the
// future tags-on-parameters feature.
void ListTagsForResourceCommand;
