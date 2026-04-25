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
 */
export function getClient<T>(
  ctx: AwsContext,
  ClientClass: new (config: { region: string; credentials: ReturnType<typeof fromIni> }) => T,
  key?: string
): T {
  const cacheKey = key ?? ClientClass.name;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new ClientClass({
      region: ctx.region,
      credentials: ctx.credentials,
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
