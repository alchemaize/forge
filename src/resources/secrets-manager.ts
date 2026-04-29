/**
 * SecretsManager resource module.
 *
 * SAFETY:
 *   - Secret VALUES are NEVER captured, logged, or modified by Forge. The value
 *     is the entire point of the secret; touching it programmatically risks data
 *     loss (anything encrypted with the value, anything that re-reads the secret
 *     mid-rotation). Whoever sets the value last (CDK, Console, manual CLI,
 *     rotation function) owns it.
 *   - Forge manages metadata only: presence, description.
 *   - destroy is REFUSED. Secret deletion has a 7-30 day pending window and
 *     anything that reads the secret breaks during/after that.
 */

import {
  SecretsManagerClient,
  DescribeSecretCommand,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import type { AwsContext } from '../aws.js';
import type { SecretConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface SecretState {
  name: string;
  arn: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeSecret(
  ctx: AwsContext,
  config: SecretConfig
): Promise<SecretState | null> {
  const sm: SecretsManagerClient = getClient(ctx, SecretsManagerClient);

  try {
    const desc = await sm.send(new DescribeSecretCommand({ SecretId: config.name }));
    return {
      name: desc.Name ?? config.name,
      arn: desc.ARN ?? '',
      description: desc.Description ?? '',
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planSecret(
  ctx: AwsContext,
  config: SecretConfig,
  _appName: string,
  plan: Plan
): Promise<SecretState | null> {
  const current = await describeSecret(ctx, config);

  if (current) {
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
    if (config.description && current.description !== config.description) {
      fields.push({ field: 'description', current: current.description, desired: config.description });
    }
    addChange(plan, {
      resourceType: 'secrets-manager',
      resourceId: config.name,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'data',
      fields,
    });
    return current;
  }

  // Forge doesn't auto-create secrets — values are too sensitive to generate blindly.
  addChange(plan, {
    resourceType: 'secrets-manager',
    resourceId: config.name,
    changeType: 'create',
    tier: 'data',
    fields: [
      { field: 'name', current: undefined, desired: config.name },
      { field: 'note', current: undefined, desired: '(MANUAL: Forge will not auto-create — set the value via Console/CLI then re-plan)' },
    ],
  });
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applySecret(
  ctx: AwsContext,
  config: SecretConfig,
  _appName: string
): Promise<SecretState> {
  const sm: SecretsManagerClient = getClient(ctx, SecretsManagerClient);
  const current = await describeSecret(ctx, config);

  if (!current) {
    throw new Error(
      `[secrets-manager] Secret '${config.name}' does not exist. Forge does not auto-create\n` +
      `secrets — the value would have to be guessed. Create it manually first:\n` +
      `  aws secretsmanager create-secret --name ${config.name} --secret-string '<value>'\n` +
      `Then run forge apply again.`
    );
  }

  // Update description only if explicitly specified and different.
  if (config.description && current.description !== config.description) {
    console.log(`[secrets-manager] ${config.name}: updating description`);
    await sm.send(new UpdateSecretCommand({
      SecretId: config.name,
      Description: config.description,
    }));
    return { ...current, description: config.description };
  }

  return current;
}

// ---------------------------------------------------------------------------
// Destroy — refused
// ---------------------------------------------------------------------------

export async function destroySecret(): Promise<never> {
  throw new Error(
    'forge refuses to destroy SecretsManager secrets. Deletion has a 7-30 day pending\n' +
    'window during which anything reading the secret fails. To delete, use the AWS\n' +
    'Console manually after confirming nothing depends on the secret.'
  );
}
