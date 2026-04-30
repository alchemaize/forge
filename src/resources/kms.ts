/**
 * KMS (customer-managed key) resource module.
 *
 * SAFETY:
 *   - destroy is REFUSED. KMS keys can't be undeleted — even ScheduleKeyDeletion
 *     has a 7-30 day pending window during which encrypted data is unrecoverable
 *     if the key disappears. Manual deletion only via AWS Console.
 *   - Key policies are NEVER touched on adopted keys. PutKeyPolicy is full-replace
 *     and a wrong policy locks out access (including the account root). Manual ops only.
 *
 * What Forge DOES manage:
 *   - Create new keys with rotation + description
 *   - Look up existing keys by alias (preferred) or keyId (adoption fallback)
 *   - Update key rotation toggle + description on adopted keys
 */

import {
  KMSClient,
  DescribeKeyCommand,
  ListAliasesCommand,
  CreateKeyCommand,
  CreateAliasCommand,
  GetKeyRotationStatusCommand,
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
} from '@aws-sdk/client-kms';
import type { AwsContext } from '../aws.js';
import type { KmsKeyConfig } from '../config.js';
import { getClient, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface KmsState {
  alias: string;
  keyId: string;
  keyArn: string;
  description: string;
  rotationEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeKms(
  ctx: AwsContext,
  config: KmsKeyConfig
): Promise<KmsState | null> {
  const kms: KMSClient = getClient(ctx, KMSClient);
  const aliasName = config.alias.startsWith('alias/') ? config.alias : `alias/${config.alias}`;

  // Resolve key ID from alias (preferred) or use config.keyId directly.
  let keyId = config.keyId;
  if (!keyId) {
    let nextMarker: string | undefined;
    do {
      const aliasRes = await kms.send(new ListAliasesCommand({ Marker: nextMarker, Limit: 100 }));
      const match = aliasRes.Aliases?.find((a: { AliasName?: string; TargetKeyId?: string }) => a.AliasName === aliasName);
      if (match?.TargetKeyId) {
        keyId = match.TargetKeyId;
        break;
      }
      nextMarker = aliasRes.NextMarker;
    } while (nextMarker);
  }

  if (!keyId) return null;

  try {
    const desc = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
    const meta = desc.KeyMetadata;
    if (!meta) return null;

    // Pending-deletion keys aren't usable; treat as not-found so plan/apply don't act on them.
    if (meta.KeyState === 'PendingDeletion') return null;

    let rotationEnabled = false;
    try {
      const rot = await kms.send(new GetKeyRotationStatusCommand({ KeyId: keyId }));
      rotationEnabled = rot.KeyRotationEnabled ?? false;
    } catch {
      // Some key types (asymmetric, HMAC) don't support rotation — that's fine.
    }

    return {
      alias: aliasName,
      keyId,
      keyArn: meta.Arn ?? '',
      description: meta.Description ?? '',
      rotationEnabled,
    };
  } catch (err: any) {
    if (err.name === 'NotFoundException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planKms(
  ctx: AwsContext,
  config: KmsKeyConfig,
  _appName: string,
  plan: Plan
): Promise<KmsState | null> {
  const current = await describeKms(ctx, config);
  const aliasName = config.alias.startsWith('alias/') ? config.alias : `alias/${config.alias}`;

  if (current) {
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
    const desiredRotation = config.enableKeyRotation ?? true;
    const desiredDesc = config.description ?? current.description;

    if (current.rotationEnabled !== desiredRotation) {
      fields.push({ field: 'rotation', current: current.rotationEnabled, desired: desiredRotation });
    }
    if (config.description && current.description !== desiredDesc) {
      fields.push({ field: 'description', current: current.description, desired: desiredDesc });
    }

    addChange(plan, {
      resourceType: 'kms',
      resourceId: aliasName,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'data',
      fields,
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'kms',
    resourceId: aliasName,
    changeType: 'create',
    tier: 'data',
    fields: [
      { field: 'alias', current: undefined, desired: aliasName },
      { field: 'description', current: undefined, desired: config.description ?? '(none)' },
      { field: 'rotation', current: undefined, desired: config.enableKeyRotation ?? true },
    ],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyKms(
  ctx: AwsContext,
  config: KmsKeyConfig,
  _appName: string
): Promise<KmsState> {
  const kms: KMSClient = getClient(ctx, KMSClient);
  const aliasName = config.alias.startsWith('alias/') ? config.alias : `alias/${config.alias}`;
  const current = await describeKms(ctx, config);

  if (current) {
    // Update rotation if config differs from live.
    const desiredRotation = config.enableKeyRotation ?? true;
    if (current.rotationEnabled !== desiredRotation) {
      console.log(`[kms] ${aliasName}: setting rotation = ${desiredRotation}`);
      if (desiredRotation) {
        await kms.send(new EnableKeyRotationCommand({ KeyId: current.keyId }));
      } else {
        await kms.send(new DisableKeyRotationCommand({ KeyId: current.keyId }));
      }
    }

    // Update description if config explicitly specifies one and it differs.
    if (config.description && current.description !== config.description) {
      console.log(`[kms] ${aliasName}: updating description`);
      await kms.send(new UpdateKeyDescriptionCommand({
        KeyId: current.keyId,
        Description: config.description,
      }));
    }

    return { ...current, description: config.description ?? current.description, rotationEnabled: desiredRotation };
  }

  console.log(`[kms] Creating customer-managed key with alias ${aliasName}`);
  const createRes = await kms.send(new CreateKeyCommand({
    Description: config.description,
    KeyUsage: 'ENCRYPT_DECRYPT',
    Origin: 'AWS_KMS',
  }));
  const keyId = createRes.KeyMetadata!.KeyId!;
  const keyArn = createRes.KeyMetadata!.Arn!;

  await kms.send(new CreateAliasCommand({
    AliasName: aliasName,
    TargetKeyId: keyId,
  }));

  if (config.enableKeyRotation !== false) {
    await kms.send(new EnableKeyRotationCommand({ KeyId: keyId }));
  }

  console.log(`[kms] Created: ${keyArn}`);
  return {
    alias: aliasName,
    keyId,
    keyArn,
    description: config.description ?? '',
    rotationEnabled: config.enableKeyRotation !== false,
  };
}

// ---------------------------------------------------------------------------
// Destroy — refused
// ---------------------------------------------------------------------------

export async function destroyKms(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy KMS keys. KMS deletion is irreversible (7-30 day pending\n' +
    'window then permanent). Anything encrypted with the key becomes unrecoverable.\n' +
    'To delete a key, use the AWS Console manually after confirming nothing depends on it.'
  );
}
