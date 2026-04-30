/**
 * WAF v2 (web ACL) resource module.
 *
 * Manages WebACLs that attach to ALBs (REGIONAL scope) or CloudFront
 * distributions (CLOUDFRONT scope, must be in us-east-1).
 *
 * Built-in support for:
 *   - AWS managed rule groups (CommonRuleSet, KnownBadInputs, etc.)
 *   - Custom rate-limit rules (per-IP rate limit)
 *   - Resource associations (auto-attach to ALB / CloudFront / API GW)
 *
 * Adoption-safe behavior:
 *   - WebACL looked up by name + scope.
 *   - Rules: full reconcile (PUT-shaped UpdateWebACL replaces the rule
 *     set). User keeps order-of-priority responsibility.
 *   - Associations: additive — Forge attaches missing, leaves extras.
 *
 * SAFETY: Compute-tier — destroy refused by default to avoid silently
 * dropping protections from a public-facing endpoint.
 */

import {
  WAFV2Client,
  ListWebACLsCommand,
  GetWebACLCommand,
  CreateWebACLCommand,
  UpdateWebACLCommand,
  ListResourcesForWebACLCommand,
  AssociateWebACLCommand,
  DisassociateWebACLCommand,
  type Scope,
} from '@aws-sdk/client-wafv2';
import type { AwsContext } from '../aws.js';
import type { WafWebAclConfig, WafRuleConfig } from '../config.js';
import { getClient, withContext, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface WebAclState {
  id: string;
  name: string;
  arn: string;
  scope: Scope;
  defaultAction: 'allow' | 'block';
  ruleCount: number;
  associatedResources: string[];
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeWebAcl(
  ctx: AwsContext,
  config: WafWebAclConfig
): Promise<WebAclState | null> {
  const waf: WAFV2Client = getClient(ctx, WAFV2Client);
  const scope = config.scope as Scope;

  let nextMarker: string | undefined;
  let summary: { Id?: string; Name?: string; ARN?: string } | undefined;
  do {
    const list = await waf.send(new ListWebACLsCommand({
      Scope: scope,
      NextMarker: nextMarker,
      Limit: 100,
    }));
    summary = list.WebACLs?.find(a => a.Name === config.name);
    if (summary) break;
    nextMarker = list.NextMarker;
  } while (nextMarker);

  if (!summary || !summary.Id || !summary.ARN) return null;

  const detail = await waf.send(new GetWebACLCommand({
    Id: summary.Id,
    Name: summary.Name,
    Scope: scope,
  }));
  const acl = detail.WebACL!;

  // Resources associated with this ACL.
  let associatedResources: string[] = [];
  if (scope === 'REGIONAL') {
    const assoc = await waf.send(new ListResourcesForWebACLCommand({
      WebACLArn: summary.ARN,
    })).catch(() => undefined);
    associatedResources = assoc?.ResourceArns ?? [];
  }
  // CloudFront associations live on the distribution itself; describing
  // them requires a CloudFront API roundtrip per distribution, which
  // we skip in describe (apply does the right thing on association).

  return {
    id: acl.Id!,
    name: acl.Name!,
    arn: summary.ARN,
    scope,
    defaultAction: acl.DefaultAction?.Allow ? 'allow' : 'block',
    ruleCount: acl.Rules?.length ?? 0,
    associatedResources,
  };
}

// ---------------------------------------------------------------------------
// Rule construction
// ---------------------------------------------------------------------------

function buildRule(rule: WafRuleConfig): any {
  const visibility = {
    SampledRequestsEnabled: rule.visibility?.sampledRequests ?? true,
    CloudWatchMetricsEnabled: rule.visibility?.cloudWatchMetrics ?? true,
    MetricName: rule.name.replace(/[^a-zA-Z0-9]/g, '_'),
  };

  if (rule.managedRuleGroup) {
    return {
      Name: rule.name,
      Priority: rule.priority,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: rule.managedRuleGroup,
        },
      },
      OverrideAction: rule.action === 'count'
        ? { Count: {} }
        : { None: {} },
      VisibilityConfig: visibility,
    };
  }

  if (rule.rateLimit) {
    return {
      Name: rule.name,
      Priority: rule.priority,
      Statement: {
        RateBasedStatement: {
          Limit: rule.rateLimit.limit,
          AggregateKeyType: rule.rateLimit.aggregateKey ?? 'IP',
        },
      },
      Action: rule.action === 'count'
        ? { Count: {} }
        : rule.action === 'allow'
          ? { Allow: {} }
          : { Block: {} },
      VisibilityConfig: visibility,
    };
  }

  throw new Error(`[waf] rule '${rule.name}': must set either managedRuleGroup or rateLimit`);
}

function canonicalizeRules(rules: any[]): string {
  return canonicalize(rules.map(r => ({
    name: r.Name,
    priority: r.Priority,
    statement: r.Statement,
    overrideAction: r.OverrideAction,
    action: r.Action,
  })));
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planWebAcl(
  ctx: AwsContext,
  config: WafWebAclConfig,
  _appName: string,
  plan: Plan
): Promise<WebAclState | null> {
  const current = await describeWebAcl(ctx, config);

  if (!current) {
    addChange(plan, {
      resourceType: 'web-acl',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'scope', current: undefined, desired: config.scope },
        { field: 'rules', current: undefined, desired: config.rules.length },
        { field: 'defaultAction', current: undefined, desired: config.defaultAction ?? 'allow' },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

  // Rule drift: canonicalize the rule shape.
  const desiredRules = config.rules.map(buildRule);
  const waf: WAFV2Client = getClient(ctx, WAFV2Client);
  const detail = await waf.send(new GetWebACLCommand({
    Id: current.id,
    Name: current.name,
    Scope: config.scope as Scope,
  }));
  const liveRules = detail.WebACL?.Rules ?? [];
  if (canonicalizeRules(liveRules) !== canonicalizeRules(desiredRules)) {
    fields.push({
      field: 'rules',
      current: `${liveRules.length} live`,
      desired: `${desiredRules.length} configured`,
    });
  }

  // Default action drift.
  const desiredDefault = config.defaultAction ?? 'allow';
  if (current.defaultAction !== desiredDefault) {
    fields.push({ field: 'defaultAction', current: current.defaultAction, desired: desiredDefault });
  }

  // Association drift (additive, REGIONAL only).
  if (config.scope === 'REGIONAL' && config.associatedResources?.length) {
    const missing = config.associatedResources.filter(a => !current.associatedResources.includes(a));
    if (missing.length > 0) {
      fields.push({
        field: 'associations',
        current: `${current.associatedResources.length} attached`,
        desired: `+${missing.length} to add`,
      });
    }
  }

  addChange(plan, {
    resourceType: 'web-acl',
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

export async function applyWebAcl(
  ctx: AwsContext,
  config: WafWebAclConfig,
  _appName: string
): Promise<WebAclState> {
  const waf: WAFV2Client = getClient(ctx, WAFV2Client);
  const scope = config.scope as Scope;
  const desiredRules = config.rules.map(buildRule);
  const defaultActionBlock = config.defaultAction === 'block';
  const visibility = {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: config.name.replace(/[^a-zA-Z0-9]/g, '_'),
  };

  let current = await describeWebAcl(ctx, config);
  if (!current) {
    console.log(`[waf] Creating web ACL: ${config.name} (${scope})`);
    try {
      const res = await waf.send(new CreateWebACLCommand({
        Name: config.name,
        Scope: scope,
        DefaultAction: defaultActionBlock ? { Block: {} } : { Allow: {} },
        Description: config.description,
        Rules: desiredRules,
        VisibilityConfig: visibility,
      }));
      const summary = res.Summary!;
      current = {
        id: summary.Id!,
        name: summary.Name!,
        arn: summary.ARN!,
        scope,
        defaultAction: defaultActionBlock ? 'block' : 'allow',
        ruleCount: desiredRules.length,
        associatedResources: [],
      };
    } catch (err) {
      throw withContext(`[waf] CreateWebACL ${config.name}`, err);
    }
  } else {
    // Update requires the LockToken, which means a fresh GetWebACL.
    const detail = await waf.send(new GetWebACLCommand({
      Id: current.id,
      Name: current.name,
      Scope: scope,
    }));
    const liveRules = detail.WebACL?.Rules ?? [];
    const liveDefaultBlock = !!detail.WebACL?.DefaultAction?.Block;
    if (
      canonicalizeRules(liveRules) !== canonicalizeRules(desiredRules) ||
      liveDefaultBlock !== defaultActionBlock
    ) {
      console.log(`[waf] Updating web ACL: ${config.name}`);
      try {
        await waf.send(new UpdateWebACLCommand({
          Name: current.name,
          Scope: scope,
          Id: current.id,
          DefaultAction: defaultActionBlock ? { Block: {} } : { Allow: {} },
          Description: config.description,
          Rules: desiredRules,
          LockToken: detail.LockToken!,
          VisibilityConfig: visibility,
        }));
      } catch (err) {
        throw withContext(`[waf] UpdateWebACL ${config.name}`, err);
      }
    }
  }

  // Reconcile resource associations (REGIONAL only — CloudFront
  // associations are managed via the CloudFront distribution config).
  if (scope === 'REGIONAL' && config.associatedResources?.length) {
    for (const resourceArn of config.associatedResources) {
      // Resolve bare names (load balancer names) to full ARNs would
      // require a separate ELB call; for now require ARNs.
      if (!resourceArn.startsWith('arn:')) {
        console.log(`[waf] Skipping association for '${resourceArn}': must be a full ARN.`);
        continue;
      }
      if (current.associatedResources.includes(resourceArn)) continue;
      console.log(`[waf] Associating: ${resourceArn}`);
      try {
        await waf.send(new AssociateWebACLCommand({
          WebACLArn: current.arn,
          ResourceArn: resourceArn,
        }));
      } catch (err) {
        throw withContext(`[waf] AssociateWebACL ${resourceArn}`, err);
      }
    }
  }

  return (await describeWebAcl(ctx, config))!;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyWebAcl(): Promise<never> {
  // Keep DisassociateWebACLCommand reachable for future fine-grained destroys.
  void DisassociateWebACLCommand;
  throw new Error(
    'forge refuses to destroy WAF web ACLs. Removing protections from a\n' +
    'public-facing endpoint silently exposes it. Disassociate from each\n' +
    'resource first, then DeleteWebACL via AWS Console.'
  );
}
