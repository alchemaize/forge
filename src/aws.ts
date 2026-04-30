/**
 * Shared AWS client factory.
 * Creates SDK clients with the correct profile and region from forge config.
 * Caches clients per service to avoid re-creating them.
 */

import { fromIni } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { ForgeConfig } from './config.js';

export interface AwsContext {
  profile: string;
  region: string;
  accountId: string;
  credentials: ReturnType<typeof fromIni>;
}

const clientCache = new Map<string, unknown>();

/**
 * Initialize AWS context — resolves account ID and validates credentials.
 */
export async function initAwsContext(config: ForgeConfig): Promise<AwsContext> {
  const profile = config.profile;
  const region = config.region ?? 'us-east-1';
  const credentials = fromIni({ profile });

  const sts = new STSClient({ region, credentials });
  let accountId: string;

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    accountId = identity.Account!;
  } catch (err: any) {
    throw new Error(
      `Failed to authenticate with AWS profile '${profile}'. ` +
      `Check ~/.aws/config and ~/.aws/credentials.\n` +
      `Error: ${err.message}`
    );
  }

  return { profile, region, accountId, credentials };
}

/**
 * Get or create a cached AWS SDK client.
 *
 * The cache key MUST include account, region, and profile so that a single
 * Node process serving multiple configs (e.g., multi-environment scripts via
 * the programmatic API) doesn't get a client pointed at the wrong account.
 * Earlier versions cached on ClientClass.name alone and would silently
 * serve a us-east-1 client when the second config asked for us-west-2.
 *
 * `maxAttempts: 6` + adaptive retry mode gives us the SDK's built-in
 * exponential backoff for ThrottlingException, ProvisionedThroughputExceeded,
 * RequestLimitExceeded, and the rest of the transient family. Without this,
 * a 50-Lambda apply that hits IAM hard could fail mid-way and leave the
 * stack half-applied.
 */
export function getClient<T>(
  ctx: AwsContext,
  ClientClass: new (config: { region: string; credentials: ReturnType<typeof fromIni>; maxAttempts?: number; retryMode?: string }) => T,
  key?: string
): T {
  const baseKey = key ?? ClientClass.name;
  const cacheKey = `${ctx.profile}:${ctx.accountId}:${ctx.region}:${baseKey}`;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new ClientClass({
      region: ctx.region,
      credentials: ctx.credentials,
      maxAttempts: 6,
      retryMode: 'adaptive',
    }));
  }
  return clientCache.get(cacheKey) as T;
}

/**
 * Clear client cache (useful for testing).
 */
export function clearClientCache(): void {
  clientCache.clear();
}

/**
 * Resolve template placeholders in strings.
 * Supports: {account}, {region}, {app}
 */
export function resolveTemplate(template: string, ctx: AwsContext, app: string): string {
  return template
    .replace(/\{account\}/g, ctx.accountId)
    .replace(/\{region\}/g, ctx.region)
    .replace(/\{app\}/g, app);
}

// ---------------------------------------------------------------------------
// ARN helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Lambda function name from a value that may be either a full
 * ARN, a versioned ARN, an aliased ARN, or already a bare function name.
 *
 * Lambda ARN shapes:
 *   arn:aws:lambda:REGION:ACCT:function:NAME
 *   arn:aws:lambda:REGION:ACCT:function:NAME:VERSION
 *   arn:aws:lambda:REGION:ACCT:function:NAME:ALIAS
 *
 * The earlier `split(':').pop()` form returned the version (e.g. "42") for
 * versioned ARNs, which then got resent as the function name and triggered
 * ResourceNotFoundException downstream. This regex anchors on "function:"
 * so the captured group is always the name regardless of trailing version.
 */
export function lambdaName(arnOrName: string | undefined | null): string {
  if (!arnOrName) return '';
  const m = arnOrName.match(/function:([^:]+)/);
  if (m) return m[1];
  // Already a bare name (no "function:" prefix).
  return arnOrName;
}

/**
 * Convert a function name (or ARN) to a full Lambda ARN. Idempotent.
 */
export function toLambdaArn(nameOrArn: string, region: string, accountId: string): string {
  if (nameOrArn.startsWith('arn:')) return nameOrArn;
  return `arn:aws:lambda:${region}:${accountId}:function:${nameOrArn}`;
}

// ---------------------------------------------------------------------------
// JSON canonicalization (drift detection)
// ---------------------------------------------------------------------------

/**
 * Stable JSON serialization with sorted keys. Used by every module's drift
 * detection so that whitespace-only or key-order differences don't trigger
 * false-positive plan diffs.
 *
 * Examples:
 *   canonicalize({b: 1, a: 2}) === canonicalize({a: 2, b: 1})  // true
 *   canonicalize([1, 2]) === canonicalize([1, 2])              // true
 *   canonicalize(null) === canonicalize(undefined)             // true (both 'null')
 */
export function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize((obj as any)[k])}`).join(',')}}`;
}
