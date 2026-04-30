/**
 * IAM Managed Policy (standalone) resource module.
 *
 * Standalone customer-managed policies (AWS::IAM::ManagedPolicy) — distinct from
 * the per-Lambda inline policies in syncRolePolicies. Used when one policy is
 * shared across multiple roles/Lambdas (visiblewealth's BedrockAccessPolicy is
 * the canonical example: one policy attached to ApiLambda, SchedulerLambda, etc.).
 *
 * Ownership model:
 *   - First apply creates the policy via CreatePolicy.
 *   - Subsequent applies compare the live policy document against config.document
 *     (canonicalized JSON) and CreatePolicyVersion + SetDefaultPolicyVersion if
 *     the document changes.
 *   - IAM caps each policy at 5 versions, so Forge prunes old non-default versions
 *     before creating a new one when at the limit.
 *   - destroy is REFUSED (data-tier-ish): the policy is referenced by roles, and
 *     deleting while attached causes runtime auth failures. Manual delete only.
 */

import {
  IAMClient,
  GetPolicyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  GetPolicyVersionCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
} from '@aws-sdk/client-iam';
import type { AwsContext } from '../aws.js';
import type { IamManagedPolicyConfig } from '../config.js';
import { getClient, canonicalize, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface ManagedPolicyState {
  name: string;
  arn: string;
  description: string;
  defaultVersionId: string;
  document: object;
}

function policyArn(accountId: string, name: string): string {
  return `arn:aws:iam::${accountId}:policy/${name}`;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeManagedPolicy(
  ctx: AwsContext,
  config: IamManagedPolicyConfig
): Promise<ManagedPolicyState | null> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  const arn = policyArn(ctx.accountId, config.name);

  let policyMeta: { Description?: string; DefaultVersionId?: string } | undefined;
  try {
    const res = await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
    if (!res.Policy) return null;
    policyMeta = { Description: res.Policy.Description, DefaultVersionId: res.Policy.DefaultVersionId };
  } catch (err: any) {
    if (err.name === 'NoSuchEntityException') return null;
    throw err;
  }

  // Get the current default version's document.
  let document: object = { Version: '2012-10-17', Statement: [] };
  if (policyMeta.DefaultVersionId) {
    try {
      const verRes = await iam.send(new GetPolicyVersionCommand({
        PolicyArn: arn,
        VersionId: policyMeta.DefaultVersionId,
      }));
      if (verRes.PolicyVersion?.Document) {
        document = JSON.parse(decodeURIComponent(verRes.PolicyVersion.Document));
      }
    } catch (err: any) {
      console.log(`[iam-policy] Warning: could not get default version of ${config.name}: ${err.message}`);
    }
  }

  return {
    name: config.name,
    arn,
    description: policyMeta.Description ?? '',
    defaultVersionId: policyMeta.DefaultVersionId ?? '',
    document,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planManagedPolicy(
  ctx: AwsContext,
  config: IamManagedPolicyConfig,
  _appName: string,
  plan: Plan
): Promise<ManagedPolicyState | null> {
  const current = await describeManagedPolicy(ctx, config);

  if (current) {
    const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
    if (canonicalize(current.document) !== canonicalize(config.document)) {
      fields.push({ field: 'document', current: '(differs)', desired: '(new version)' });
    }
    if (config.description && current.description !== config.description) {
      fields.push({ field: 'description', current: current.description, desired: config.description });
    }
    addChange(plan, {
      resourceType: 'managed-policy',
      resourceId: config.name,
      changeType: fields.length > 0 ? 'update' : 'unchanged',
      tier: 'config',
      fields,
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'managed-policy',
    resourceId: config.name,
    changeType: 'create',
    tier: 'config',
    fields: [{ field: 'name', current: undefined, desired: config.name }],
  });
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyManagedPolicy(
  ctx: AwsContext,
  config: IamManagedPolicyConfig,
  _appName: string
): Promise<ManagedPolicyState> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  const arn = policyArn(ctx.accountId, config.name);
  const current = await describeManagedPolicy(ctx, config);

  if (!current) {
    console.log(`[iam-policy] Creating managed policy: ${config.name}`);
    const res = await iam.send(new CreatePolicyCommand({
      PolicyName: config.name,
      Description: config.description,
      PolicyDocument: JSON.stringify(config.document),
    }));
    return {
      name: config.name,
      arn,
      description: config.description ?? '',
      defaultVersionId: res.Policy?.DefaultVersionId ?? 'v1',
      document: config.document,
    };
  }

  // Document drift → new version.
  const docChanged = canonicalize(current.document) !== canonicalize(config.document);
  if (docChanged) {
    // IAM caps each policy at 5 versions. Prune oldest non-default before adding.
    try {
      const versionsRes = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }));
      const nonDefault = (versionsRes.Versions ?? [])
        .filter(v => !v.IsDefaultVersion)
        .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0));
      // Remove all but 3 oldest non-default versions to leave room for the new one + default.
      while ((versionsRes.Versions?.length ?? 0) >= 5 && nonDefault.length > 0) {
        const oldest = nonDefault.shift();
        if (oldest?.VersionId) {
          console.log(`[iam-policy] Pruning old version: ${oldest.VersionId}`);
          await iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: oldest.VersionId }));
        }
      }
    } catch (err: any) {
      console.log(`[iam-policy] Warning: could not prune old versions of ${config.name}: ${err.message}`);
    }

    console.log(`[iam-policy] Creating new policy version for ${config.name}`);
    await iam.send(new CreatePolicyVersionCommand({
      PolicyArn: arn,
      PolicyDocument: JSON.stringify(config.document),
      SetAsDefault: true,
    }));
  }

  // IAM managed policy descriptions are IMMUTABLE after CreatePolicy — there's no
  // UpdatePolicyDescription API. If config.description differs from current, log a
  // note and continue (the document version was just updated which is what matters).
  if (config.description && current.description !== config.description) {
    console.log(
      `[iam-policy] ${config.name}: description differs but IAM doesn't allow description updates ` +
      `on existing managed policies. To change, manually delete + recreate.`
    );
  }

  return { ...current, document: config.document };
}

// ---------------------------------------------------------------------------
// Destroy — refused
// ---------------------------------------------------------------------------

export async function destroyManagedPolicy(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy IAM managed policies. The policy is likely attached to\n' +
    'roles; deletion would break those roles\' permissions immediately. Detach from\n' +
    'all roles first, then delete via AWS Console or CLI manually.'
  );
}
