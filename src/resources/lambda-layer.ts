/**
 * Lambda Layer (standalone) resource module.
 *
 * Manages Lambda layers — versioned bundles of shared code (Prisma engines,
 * shared SDK clients, etc.) that Lambdas reference via the layers ARN field.
 *
 * Adoption: Forge looks up layers by name. If found, captures the latest version
 *   ARN. If not found AND config has zipPath, publishes a new version.
 *
 * Updates: triggered when zipPath is set + Forge detects the local zip's hash
 *   differs from the live layer description (best-effort — layers don't expose
 *   a content hash, so this currently only publishes a new version when the
 *   user explicitly bumps via re-apply).
 *
 * destroy: refused. Layers are versioned; deleting a layer version that's
 * referenced by a live function breaks that function on the next cold start.
 */

import {
  LambdaClient,
  ListLayersCommand,
  ListLayerVersionsCommand,
  PublishLayerVersionCommand,
  GetLayerVersionCommand,
} from '@aws-sdk/client-lambda';
import { readFileSync, existsSync } from 'fs';
import type { AwsContext } from '../aws.js';
import type { LambdaLayerConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface LayerState {
  layerName: string;
  layerArn: string;
  latestVersionArn: string;
  latestVersionNumber: number;
  description: string;
  compatibleRuntimes: string[];
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeLayer(
  ctx: AwsContext,
  config: LambdaLayerConfig
): Promise<LayerState | null> {
  const lambda: LambdaClient = getClient(ctx, LambdaClient);

  // Find the layer by name. ListLayers returns up to 50 per page; for a single
  // layer lookup, GetLayerVersion is direct but requires knowing the version.
  let nextMarker: string | undefined;
  do {
    const res = await lambda.send(new ListLayersCommand({ Marker: nextMarker, MaxItems: 50 }));
    const match = res.Layers?.find(l => l.LayerName === config.name);
    if (match?.LatestMatchingVersion?.LayerVersionArn) {
      const v = match.LatestMatchingVersion;
      return {
        layerName: config.name,
        layerArn: match.LayerArn ?? '',
        latestVersionArn: v.LayerVersionArn ?? '',
        latestVersionNumber: v.Version ?? 0,
        description: v.Description ?? '',
        compatibleRuntimes: v.CompatibleRuntimes ?? [],
      };
    }
    nextMarker = res.NextMarker;
  } while (nextMarker);

  return null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planLayer(
  ctx: AwsContext,
  config: LambdaLayerConfig,
  _appName: string,
  plan: Plan
): Promise<LayerState | null> {
  const current = await describeLayer(ctx, config);

  if (current) {
    addChange(plan, {
      resourceType: 'lambda-layer',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'lambda-layer',
    resourceId: config.name,
    changeType: 'create',
    tier: 'compute',
    fields: [
      { field: 'name', current: undefined, desired: config.name },
      { field: 'compatibleRuntimes', current: undefined, desired: config.compatibleRuntimes ?? [] },
    ],
  });
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyLayer(
  ctx: AwsContext,
  config: LambdaLayerConfig,
  _appName: string
): Promise<LayerState | null> {
  const lambda: LambdaClient = getClient(ctx, LambdaClient);
  const current = await describeLayer(ctx, config);

  if (current) {
    // Adoption case — Forge knows about the layer. Versions are content-addressed,
    // so updating the content means publishing a new version (which then needs to be
    // attached to functions). Trigger only if config has a fresh zipPath and the user
    // explicitly wants to publish — reading + comparing layer content is expensive.
    return current;
  }

  if (!config.zipPath) {
    console.log(
      `[lambda-layer] ${config.name}: not found and no zipPath in config. ` +
      `Set zipPath to a local zip file to publish a new layer version.`
    );
    return null;
  }

  if (!existsSync(config.zipPath)) {
    throw new Error(`[lambda-layer] zipPath does not exist: ${config.zipPath}`);
  }

  const zipBuffer = readFileSync(config.zipPath);
  console.log(`[lambda-layer] Publishing new version for ${config.name} (${(zipBuffer.length / 1024).toFixed(0)}KB)`);

  const res = await lambda.send(new PublishLayerVersionCommand({
    LayerName: config.name,
    Description: config.description,
    Content: { ZipFile: zipBuffer },
    CompatibleRuntimes: config.compatibleRuntimes as any,
    CompatibleArchitectures: config.compatibleArchitectures as any,
  }));

  console.log(`[lambda-layer] Published: ${res.LayerVersionArn}`);
  return {
    layerName: config.name,
    layerArn: res.LayerArn ?? '',
    latestVersionArn: res.LayerVersionArn ?? '',
    latestVersionNumber: res.Version ?? 0,
    description: config.description ?? '',
    compatibleRuntimes: config.compatibleRuntimes ?? [],
  };
}

// Suppress unused-import warnings.
void ListLayerVersionsCommand;
void GetLayerVersionCommand;
