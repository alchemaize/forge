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

/**
 * IAM is eventually consistent. After CreateRole / CreateInstanceProfile /
 * AttachRolePolicy / PutRolePolicy, the principal isn't always immediately
 * visible to other services (Lambda's CreateFunction in particular returns
 * `InvalidParameterValueException: The role defined for the function cannot
 * be assumed by Lambda` if used too quickly). The standard mitigation is a
 * 10-second wait.
 *
 * Earlier this magic number was repeated in 4 modules (lambda.ts, rds.ts,
 * step-functions.ts, vpc.ts). One helper, one place to tune if AWS ever
 * fixes the underlying race.
 */
export function awaitIamPropagation(reason?: string, ms = 10000): Promise<void> {
  if (reason) console.log(`[iam] Waiting ${(ms / 1000).toFixed(0)}s for propagation (${reason})...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Inverse of resolveTemplate: replace account ID and region in a value
 * (typically a captured AWS resource name) with `{account}` / `{region}`
 * placeholders, so generated configs are portable across accounts.
 *
 * Earlier the import path used a raw `value.replace(ctx.accountId, '{account}')`
 * which would corrupt strings if the 12-digit account ID happened to appear
 * inside a longer numeric suffix (CFN-generated UUIDs sometimes embed
 * coincidentally matching digit runs). This anchors on non-digit
 * boundaries so only standalone account-ID occurrences get rewritten.
 */
export function templatizeName(value: string, ctx: AwsContext): string {
  // Account ID: 12-digit run, NOT preceded or followed by another digit.
  const accountPattern = new RegExp(`(^|[^0-9])${ctx.accountId}(?![0-9])`, 'g');
  // Region: standard AWS pattern (us-east-1 / eu-west-2 / etc.). Anchor on
  // alphanumeric boundaries — must be preceded by start-of-string or a
  // non-alphanumeric (so `us-east-1` matches inside `lambda-us-east-1-foo`
  // but not inside `pus-east-1ish`), and followed by a non-alphanumeric
  // (so the AZ `us-east-1a` doesn't match because the trailing `a` would
  // be part of the AZ name, not a separator).
  const regionPattern = new RegExp(`(^|[^a-z0-9])${ctx.region}(?![a-z0-9])`, 'g');
  return value
    .replace(accountPattern, (_, before) => `${before}{account}`)
    .replace(regionPattern, (_, before) => `${before}{region}`);
}

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

/**
 * Base class for any error Forge raises intentionally. Lets callers
 * distinguish "Forge said no" from "the AWS SDK threw" via instanceof.
 *
 * Hierarchy:
 *   ForgeError (abstract base)
 *     ├── ForgeRefusedError    -- destroy or apply explicitly refused
 *     ├── ForgeDriftError      -- live state diverges in a way Forge can't fix
 *     └── ForgeAwsError        -- wrap of an SDK error with actionable hint
 *
 * Why bother: a future CI integration (or `forge plan --json` consumer)
 * needs to know which exit code to use without parsing message strings.
 * Refused-by-policy is a different signal from "AWS rate-limited and we
 * gave up after retries." Hierarchy gives consumers a clean way to
 * branch on that.
 */
export class ForgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ForgeError';
  }
}

/**
 * Raised when Forge refuses to perform a requested action (typical for
 * tier-1 destroys: VPC, RDS, IAM users, etc.). Caller-actionable message
 * is in `.message`; this is never the result of an AWS-side failure.
 */
export class ForgeRefusedError extends ForgeError {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRefusedError';
  }
}

/**
 * Raised when Forge detects drift it cannot resolve automatically (e.g.,
 * a config referencing a Lambda target on an EventBridge rule whose live
 * target is an SQS queue, or a major-version RDS engine bump that needs
 * manual review). Plan output remains the primary surface; this class is
 * for cases where apply must stop and ask.
 */
export class ForgeDriftError extends ForgeError {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeDriftError';
  }
}

/**
 * Wrap of an AWS SDK error with Forge's actionable-hint prefix. Keeps
 * the original error available via `.cause` so debug output can drill
 * back to the SDK layer.
 */
export class ForgeAwsError extends ForgeError {
  /** AWS SDK error name (e.g., 'AccessDeniedException'). */
  awsErrorName: string;
  constructor(message: string, awsErrorName: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ForgeAwsError';
    this.awsErrorName = awsErrorName;
  }
}

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap an SDK error with actionable context. Forge tries to give every
 * user-facing error a "what to do next" line so the user isn't staring
 * at a raw AccessDeniedException with no idea where to go.
 *
 * Usage:
 *   try { await sdkCall() } catch (err) { throw withContext('[lambda] creating myapp-api', err); }
 */
export function withContext(prefix: string, err: unknown): ForgeAwsError {
  const msg = err instanceof Error ? err.message : String(err);
  const name = (err as { name?: string }).name ?? '';

  let hint = '';
  if (name === 'AccessDeniedException' || name === 'AccessDenied' || /access denied/i.test(msg)) {
    hint = '\n  Hint: the AWS profile likely lacks permissions for this call. Check the IAM policy on the profile or assumed role.';
  } else if (name === 'ResourceNotFoundException' || name === 'NotFound') {
    hint = '\n  Hint: the resource was expected to exist. Check the name in your forge.config.ts and confirm the profile points at the right account/region.';
  } else if (name === 'ValidationException') {
    hint = '\n  Hint: AWS rejected the request shape. The error message above usually names the bad field.';
  } else if (name === 'ThrottlingException' || name === 'RequestLimitExceeded') {
    hint = '\n  Hint: AWS is rate-limiting. Forge retries automatically (adaptive); persistent throttles mean the account is hitting service quotas. Wait a minute or open a quota request.';
  } else if (name === 'ResourceConflictException' || name === 'AlreadyExists') {
    hint = '\n  Hint: a resource with this name already exists. If you meant to adopt it, ensure your config name matches AWS exactly. If you meant to recreate, destroy first via the AWS Console.';
  } else if (name === 'CredentialsProviderError' || name === 'ExpiredTokenException' || /expired/i.test(msg)) {
    hint = '\n  Hint: AWS credentials are expired or invalid. Re-run `aws sso login --profile <profile>` if SSO, or refresh static credentials in ~/.aws/credentials.';
  }

  const wrapped = new ForgeAwsError(`${prefix}: ${msg}${hint}`, name, err);
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
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
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
}
