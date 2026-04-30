/**
 * ECR resource module.
 *
 * Manages container image repositories with image-scan and lifecycle
 * configuration. Standalone module (was previously bundled inside
 * ecs-express.ts).
 *
 * Adoption-safe behavior:
 *   - Existing repos with the same name are adopted in place.
 *   - Lifecycle policy: drift-detected by canonicalized JSON compare.
 *     Apply only PUTs the policy when it differs from live.
 *   - Image scan setting: drift-detected and updated.
 *
 * SAFETY: Compute-tier — destroy refused (running ECS / Lambda / App
 * Runner workloads referencing the image break immediately if the
 * repo is deleted).
 */

import {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
  GetLifecyclePolicyCommand,
  PutImageScanningConfigurationCommand,
} from '@aws-sdk/client-ecr';
import type { AwsContext } from '../aws.js';
import type { EcrRepoConfig } from '../config.js';
import { getClient, withContext, canonicalize, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface EcrState {
  repoName: string;
  repoUri: string;
  repoArn: string;
  scanOnPush: boolean;
  lifecyclePolicyJson?: string;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeEcr(
  ctx: AwsContext,
  repoName: string
): Promise<EcrState | null> {
  const ecr: ECRClient = getClient(ctx, ECRClient);

  let repoArn: string;
  let repoUri: string;
  let scanOnPush: boolean;
  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({
      repositoryNames: [repoName],
    }));
    const repo = res.repositories?.[0];
    if (!repo) return null;
    repoArn = repo.repositoryArn!;
    repoUri = repo.repositoryUri!;
    scanOnPush = repo.imageScanningConfiguration?.scanOnPush ?? false;
  } catch (err: any) {
    if (err.name === 'RepositoryNotFoundException') return null;
    throw err;
  }

  // Lifecycle policy (separate API call; absence is normal).
  let lifecyclePolicyJson: string | undefined;
  try {
    const lp = await ecr.send(new GetLifecyclePolicyCommand({ repositoryName: repoName }));
    lifecyclePolicyJson = lp.lifecyclePolicyText;
  } catch (err: any) {
    if (err.name !== 'LifecyclePolicyNotFoundException') throw err;
  }

  return {
    repoName,
    repoUri,
    repoArn,
    scanOnPush,
    lifecyclePolicyJson,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the desired lifecycle policy JSON. Forge defaults to "keep the last
 * N images" for any tag, which is the right policy for almost every
 * single-app repo. Override by setting lifecycleKeep to 0 (no policy).
 */
function buildLifecyclePolicy(config: EcrRepoConfig): string | undefined {
  const keepCount = config.lifecycleKeep ?? 5;
  if (keepCount === 0) return undefined;
  return JSON.stringify({
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
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planEcr(
  ctx: AwsContext,
  config: EcrRepoConfig,
  _appName: string,
  plan: Plan
): Promise<EcrState | null> {
  const current = await describeEcr(ctx, config.name);
  const desiredScan = config.scanOnPush ?? true;
  const desiredPolicy = buildLifecyclePolicy(config);

  if (!current) {
    addChange(plan, {
      resourceType: 'ecr',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'scanOnPush', current: undefined, desired: desiredScan },
        { field: 'lifecycleKeep', current: undefined, desired: config.lifecycleKeep ?? 5 },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.scanOnPush !== desiredScan) {
    fields.push({ field: 'scanOnPush', current: current.scanOnPush, desired: desiredScan });
  }
  // Compare canonicalized JSON to avoid whitespace/key-order false positives.
  const currentNorm = current.lifecyclePolicyJson ? canonicalize(JSON.parse(current.lifecyclePolicyJson)) : 'null';
  const desiredNorm = desiredPolicy ? canonicalize(JSON.parse(desiredPolicy)) : 'null';
  if (currentNorm !== desiredNorm) {
    fields.push({
      field: 'lifecyclePolicy',
      current: current.lifecyclePolicyJson ? '(differs)' : 'none',
      desired: desiredPolicy ? `keep last ${config.lifecycleKeep ?? 5}` : 'none',
    });
  }

  addChange(plan, {
    resourceType: 'ecr',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyEcr(
  ctx: AwsContext,
  config: EcrRepoConfig,
  appName: string
): Promise<EcrState> {
  const ecr: ECRClient = getClient(ctx, ECRClient);
  let current = await describeEcr(ctx, config.name);
  const desiredScan = config.scanOnPush ?? true;
  const desiredPolicy = buildLifecyclePolicy(config);

  if (!current) {
    console.log(`[ecr] Creating repository: ${config.name}`);
    try {
      const res = await ecr.send(new CreateRepositoryCommand({
        repositoryName: config.name,
        imageScanningConfiguration: { scanOnPush: desiredScan },
        tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }));
      const repo = res.repository!;
      console.log(`[ecr] Created: ${repo.repositoryUri}`);
      current = {
        repoName: repo.repositoryName!,
        repoUri: repo.repositoryUri!,
        repoArn: repo.repositoryArn!,
        scanOnPush: desiredScan,
      };
    } catch (err) {
      throw withContext(`[ecr] CreateRepository ${config.name}`, err);
    }
  } else {
    console.log(`[ecr] Repository exists: ${config.name}`);
  }

  // Reconcile scan setting only if it drifts.
  if (current.scanOnPush !== desiredScan) {
    console.log(`[ecr] ${config.name}: setting scanOnPush=${desiredScan}`);
    await ecr.send(new PutImageScanningConfigurationCommand({
      repositoryName: config.name,
      imageScanningConfiguration: { scanOnPush: desiredScan },
    }));
    current.scanOnPush = desiredScan;
  }

  // Reconcile lifecycle policy. Compare canonicalized JSON; PUT only if drift.
  const currentNorm = current.lifecyclePolicyJson
    ? canonicalize(JSON.parse(current.lifecyclePolicyJson))
    : 'null';
  const desiredNorm = desiredPolicy ? canonicalize(JSON.parse(desiredPolicy)) : 'null';
  if (currentNorm !== desiredNorm) {
    if (desiredPolicy) {
      console.log(`[ecr] ${config.name}: applying lifecycle policy`);
      try {
        await ecr.send(new PutLifecyclePolicyCommand({
          repositoryName: config.name,
          lifecyclePolicyText: desiredPolicy,
        }));
        current.lifecyclePolicyJson = desiredPolicy;
      } catch (err) {
        throw withContext(`[ecr] PutLifecyclePolicy ${config.name}`, err);
      }
    } else {
      // The user opted out of a lifecycle policy (lifecycleKeep === 0).
      // ECR doesn't have a "remove the policy" API surface that's
      // commonly used; we leave any existing policy alone and log.
      console.log(`[ecr] ${config.name}: lifecycleKeep === 0; leaving any existing policy alone (delete via Console if needed)`);
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyEcr(_ctx: AwsContext, name: string): Promise<never> {
  throw new ForgeRefusedError(
    `forge refuses to destroy ECR repository '${name}'. Running ECS / Lambda / App Runner\n` +
    'workloads referencing the image break immediately. Empty + delete via AWS Console.'
  );
}
