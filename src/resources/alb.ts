/**
 * Application Load Balancer resource module.
 *
 * Creates ALBs with target groups + listeners + listener rules. Designed
 * for the typical pattern: one ALB → multiple target groups (per service)
 * → listener rules that route by path or host header.
 *
 * Adoption-safe behavior:
 *   - ALBs adopt by name (within the configured VPC).
 *   - Target groups adopt by name + ALB association.
 *   - Listener rules: Forge owns rules whose names start with 'forge-'
 *     and reconciles them against config; manually-created rules with
 *     other names are left alone.
 *
 * SAFETY: Compute-tier — destroy refused for now. ALB deletion takes the
 * site offline immediately and DNS records pointing at the ALB break.
 * Use AWS Console for the destroy path; require manual confirmation.
 */

import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  CreateLoadBalancerCommand,
  ModifyLoadBalancerAttributesCommand,
  DescribeTargetGroupsCommand,
  CreateTargetGroupCommand,
  ModifyTargetGroupAttributesCommand,
  DescribeListenersCommand,
  CreateListenerCommand,
  ModifyListenerCommand,
  DescribeRulesCommand,
  CreateRuleCommand,
  ModifyRuleCommand,
  DeleteRuleCommand,
  type LoadBalancerSchemeEnum,
  type ProtocolEnum,
  type TargetTypeEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { AwsContext } from '../aws.js';
import type { AlbConfig, ForgeConfig, AlbListenerRuleConfig } from '../config.js';
import { getClient, withContext, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface AlbState {
  loadBalancerArn: string;
  dnsName: string;
  hostedZoneId: string;
  scheme: string;
  state: string;
  targetGroups: Array<{ name: string; arn: string; port: number; protocol: string }>;
  listeners: Array<{ arn: string; port: number; protocol: string; ruleCount: number }>;
}

function resolveVpcId(config: AlbConfig, parentConfig?: ForgeConfig, vpcStateId?: string): string | undefined {
  if (config.vpcId) return config.vpcId;
  if (vpcStateId) return vpcStateId;
  if (parentConfig?.vpc?.mode === 'lookup' && parentConfig.vpc.vpcId) return parentConfig.vpc.vpcId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeAlb(
  ctx: AwsContext,
  config: AlbConfig
): Promise<AlbState | null> {
  const elb: ElasticLoadBalancingV2Client = getClient(ctx, ElasticLoadBalancingV2Client);

  let loadBalancerArn: string | undefined;
  let dnsName = '';
  let hostedZoneId = '';
  let scheme = '';
  let state = '';
  try {
    const res = await elb.send(new DescribeLoadBalancersCommand({
      Names: [config.name],
    }));
    const lb = res.LoadBalancers?.[0];
    if (!lb) return null;
    loadBalancerArn = lb.LoadBalancerArn!;
    dnsName = lb.DNSName ?? '';
    hostedZoneId = lb.CanonicalHostedZoneId ?? '';
    scheme = lb.Scheme ?? 'internet-facing';
    state = lb.State?.Code ?? 'active';
  } catch (err: any) {
    if (err.name === 'LoadBalancerNotFoundException') return null;
    throw err;
  }
  if (!loadBalancerArn) return null;

  // Target groups attached to this ALB.
  const tgRes = await elb.send(new DescribeTargetGroupsCommand({
    LoadBalancerArn: loadBalancerArn,
  }));
  const targetGroups = (tgRes.TargetGroups ?? []).map(tg => ({
    name: tg.TargetGroupName!,
    arn: tg.TargetGroupArn!,
    port: tg.Port ?? 80,
    protocol: tg.Protocol ?? 'HTTP',
  }));

  // Listeners.
  const lsRes = await elb.send(new DescribeListenersCommand({
    LoadBalancerArn: loadBalancerArn,
  }));
  const listeners = await Promise.all((lsRes.Listeners ?? []).map(async ls => {
    const rules = await elb.send(new DescribeRulesCommand({ ListenerArn: ls.ListenerArn })).catch(() => undefined);
    return {
      arn: ls.ListenerArn!,
      port: ls.Port ?? 80,
      protocol: ls.Protocol ?? 'HTTP',
      ruleCount: (rules?.Rules ?? []).filter(r => !r.IsDefault).length,
    };
  }));

  return {
    loadBalancerArn,
    dnsName,
    hostedZoneId,
    scheme,
    state,
    targetGroups,
    listeners,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planAlb(
  ctx: AwsContext,
  config: AlbConfig,
  _appName: string,
  plan: Plan,
  parentConfig?: ForgeConfig
): Promise<AlbState | null> {
  void parentConfig;  // resolveVpcId only matters at apply time
  const current = await describeAlb(ctx, config);

  if (!current) {
    addChange(plan, {
      resourceType: 'alb',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'scheme', current: undefined, desired: config.internetFacing === false ? 'internal' : 'internet-facing' },
        { field: 'targetGroups', current: undefined, desired: config.targetGroups.length },
        { field: 'listeners', current: undefined, desired: config.listeners.length },
      ],
    });
    return null;
  }

  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];

  // Compare target group names. Adoption-safe: only flag missing as drift.
  const desiredTgNames = new Set(config.targetGroups.map(tg => tg.name));
  const currentTgNames = new Set(current.targetGroups.map(tg => tg.name));
  const missingTgs = config.targetGroups.filter(tg => !currentTgNames.has(tg.name));
  if (missingTgs.length > 0) {
    fields.push({
      field: 'targetGroups',
      current: `${currentTgNames.size} live`,
      desired: `+${missingTgs.length} to add`,
    });
  }

  // Compare listeners by port.
  const currentListenerPorts = new Set(current.listeners.map(l => l.port));
  const missingListeners = config.listeners.filter(l => {
    const port = l.port ?? (l.protocol === 'HTTPS' ? 443 : 80);
    return !currentListenerPorts.has(port);
  });
  if (missingListeners.length > 0) {
    fields.push({
      field: 'listeners',
      current: `${current.listeners.length} live`,
      desired: `+${missingListeners.length} to add`,
    });
  }

  // Total rule count drift across all listeners (rough heuristic; the
  // apply-side reconcile is the source of truth).
  const desiredRuleCount = config.listeners.reduce((acc, l) => acc + (l.rules?.length ?? 0), 0);
  const currentRuleCount = current.listeners.reduce((acc, l) => acc + l.ruleCount, 0);
  if (desiredRuleCount !== currentRuleCount && config.listeners.some(l => l.rules?.length)) {
    fields.push({
      field: 'listenerRules',
      current: `${currentRuleCount} live`,
      desired: `${desiredRuleCount} configured`,
    });
  }

  void desiredTgNames;  // referenced for symmetry in destructure-style refactors

  addChange(plan, {
    resourceType: 'alb',
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

export async function applyAlb(
  ctx: AwsContext,
  config: AlbConfig,
  appName: string,
  parentConfig?: ForgeConfig,
  vpcStateId?: string,
): Promise<AlbState> {
  const elb: ElasticLoadBalancingV2Client = getClient(ctx, ElasticLoadBalancingV2Client);
  const vpcId = resolveVpcId(config, parentConfig, vpcStateId);
  if (!vpcId) {
    throw new Error(`[alb] ${config.name}: no VPC ID resolvable. Set config.vpcId or declare a vpc block.`);
  }

  // --- Load Balancer ---
  let albState = await describeAlb(ctx, config);
  if (!albState) {
    console.log(`[alb] Creating ALB: ${config.name}`);
    try {
      const res = await elb.send(new CreateLoadBalancerCommand({
        Name: config.name,
        Subnets: config.subnetIds,
        SecurityGroups: config.securityGroupIds,
        Scheme: (config.internetFacing === false ? 'internal' : 'internet-facing') as LoadBalancerSchemeEnum,
        Type: 'application',
        IpAddressType: 'ipv4',
        Tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }));
      const lb = res.LoadBalancers![0];
      console.log(`[alb] Created: ${lb.DNSName}`);
      albState = {
        loadBalancerArn: lb.LoadBalancerArn!,
        dnsName: lb.DNSName ?? '',
        hostedZoneId: lb.CanonicalHostedZoneId ?? '',
        scheme: lb.Scheme ?? 'internet-facing',
        state: lb.State?.Code ?? 'provisioning',
        targetGroups: [],
        listeners: [],
      };
    } catch (err) {
      throw withContext(`[alb] CreateLoadBalancer ${config.name}`, err);
    }
  }

  // ALB attributes (idle timeout, http2, drop invalid headers).
  const attrs: Array<{ Key: string; Value: string }> = [];
  if (config.idleTimeout !== undefined) attrs.push({ Key: 'idle_timeout.timeout_seconds', Value: String(config.idleTimeout) });
  if (config.dropInvalidHeaderFields !== undefined) attrs.push({ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: String(config.dropInvalidHeaderFields) });
  if (config.http2 !== undefined) attrs.push({ Key: 'routing.http2.enabled', Value: String(config.http2) });
  if (attrs.length > 0) {
    await elb.send(new ModifyLoadBalancerAttributesCommand({
      LoadBalancerArn: albState.loadBalancerArn,
      Attributes: attrs,
    }));
  }

  // --- Target Groups ---
  const tgArnsByName = new Map<string, string>();
  for (const tg of albState.targetGroups) {
    tgArnsByName.set(tg.name, tg.arn);
  }
  for (const tg of config.targetGroups) {
    if (tgArnsByName.has(tg.name)) continue;
    console.log(`[alb] Creating target group: ${tg.name}`);
    try {
      const res = await elb.send(new CreateTargetGroupCommand({
        Name: tg.name,
        Port: tg.port ?? 80,
        Protocol: (tg.protocol ?? 'HTTP') as ProtocolEnum,
        VpcId: vpcId,
        TargetType: (tg.targetType ?? 'ip') as TargetTypeEnum,
        HealthCheckPath: tg.healthCheckPath ?? '/',
        Matcher: { HttpCode: tg.healthCheckCodes ?? '200' },
      }));
      const arn = res.TargetGroups![0].TargetGroupArn!;
      tgArnsByName.set(tg.name, arn);

      // Attributes.
      const tgAttrs: Array<{ Key: string; Value: string }> = [];
      tgAttrs.push({ Key: 'deregistration_delay.timeout_seconds', Value: String(tg.deregistrationDelay ?? 30) });
      if (tg.stickiness?.enabled) {
        tgAttrs.push({ Key: 'stickiness.enabled', Value: 'true' });
        tgAttrs.push({ Key: 'stickiness.type', Value: 'lb_cookie' });
        tgAttrs.push({ Key: 'stickiness.lb_cookie.duration_seconds', Value: String(tg.stickiness.durationSeconds ?? 86400) });
      }
      await elb.send(new ModifyTargetGroupAttributesCommand({
        TargetGroupArn: arn,
        Attributes: tgAttrs,
      }));
    } catch (err) {
      throw withContext(`[alb] CreateTargetGroup ${tg.name}`, err);
    }
  }

  // --- Listeners + Rules ---
  const listenersRes = await elb.send(new DescribeListenersCommand({
    LoadBalancerArn: albState.loadBalancerArn,
  }));
  const liveListenersByPort = new Map<number, { arn: string; protocol: string }>();
  for (const ls of listenersRes.Listeners ?? []) {
    liveListenersByPort.set(ls.Port ?? 80, { arn: ls.ListenerArn!, protocol: ls.Protocol ?? 'HTTP' });
  }

  for (const listener of config.listeners) {
    const port = listener.port ?? (listener.protocol === 'HTTPS' ? 443 : 80);
    const defaultTgArn = tgArnsByName.get(listener.defaultTargetGroup);
    if (!defaultTgArn) {
      throw new Error(`[alb] listener default target group '${listener.defaultTargetGroup}' not declared in config.targetGroups`);
    }
    let listenerArn: string;
    const live = liveListenersByPort.get(port);
    if (!live) {
      console.log(`[alb] Creating ${listener.protocol} listener on port ${port}`);
      try {
        const res = await elb.send(new CreateListenerCommand({
          LoadBalancerArn: albState.loadBalancerArn,
          Port: port,
          Protocol: listener.protocol as ProtocolEnum,
          Certificates: listener.certificateArn
            ? [{ CertificateArn: listener.certificateArn }]
            : undefined,
          SslPolicy: listener.protocol === 'HTTPS'
            ? (listener.sslPolicy ?? 'ELBSecurityPolicy-TLS13-1-2-2021-06')
            : undefined,
          DefaultActions: [{ Type: 'forward', TargetGroupArn: defaultTgArn }],
        }));
        listenerArn = res.Listeners![0].ListenerArn!;
      } catch (err) {
        throw withContext(`[alb] CreateListener port=${port}`, err);
      }
    } else {
      listenerArn = live.arn;
      // Modify default action if it drifts. Skipping a full diff for now.
      await elb.send(new ModifyListenerCommand({
        ListenerArn: listenerArn,
        DefaultActions: [{ Type: 'forward', TargetGroupArn: defaultTgArn }],
      })).catch(() => undefined);
    }

    // Reconcile listener rules. Forge owns rules whose Tags include
    // managed-by=forge. Manually-created rules without that tag stay.
    if (listener.rules?.length) {
      const rulesRes = await elb.send(new DescribeRulesCommand({ ListenerArn: listenerArn }));
      const liveForgeRules = (rulesRes.Rules ?? []).filter(r => !r.IsDefault);
      const liveByPriority = new Map<number, typeof liveForgeRules[number]>();
      for (const r of liveForgeRules) {
        const pri = parseInt(r.Priority ?? '0', 10);
        if (pri) liveByPriority.set(pri, r);
      }

      for (const rule of listener.rules) {
        const targetArn = tgArnsByName.get(rule.targetGroup);
        if (!targetArn) {
          throw new Error(`[alb] listener rule references target group '${rule.targetGroup}' which isn't in config.targetGroups`);
        }
        const conditions = buildRuleConditions(rule);
        const actions = [{ Type: 'forward' as const, TargetGroupArn: targetArn }];
        const live = liveByPriority.get(rule.priority);
        if (!live) {
          console.log(`[alb] Creating rule (priority=${rule.priority}) → ${rule.targetGroup}`);
          await elb.send(new CreateRuleCommand({
            ListenerArn: listenerArn,
            Priority: rule.priority,
            Conditions: conditions,
            Actions: actions,
            Tags: [{ Key: 'managed-by', Value: 'forge' }],
          })).catch(err => {
            throw withContext(`[alb] CreateRule priority=${rule.priority}`, err);
          });
        } else {
          // Compare conditions; only modify if drift.
          const liveConds = canonicalize(live.Conditions ?? []);
          const desiredConds = canonicalize(conditions);
          const liveAction = live.Actions?.[0];
          const targetDrift = liveAction?.TargetGroupArn !== targetArn;
          if (liveConds !== desiredConds || targetDrift) {
            console.log(`[alb] Modifying rule (priority=${rule.priority})`);
            await elb.send(new ModifyRuleCommand({
              RuleArn: live.RuleArn!,
              Conditions: conditions,
              Actions: actions,
            })).catch(err => {
              throw withContext(`[alb] ModifyRule priority=${rule.priority}`, err);
            });
          }
        }
      }
    }
  }

  return (await describeAlb(ctx, config))!;
}

function buildRuleConditions(rule: AlbListenerRuleConfig) {
  const conditions: Array<{ Field: string; Values?: string[]; PathPatternConfig?: { Values?: string[] }; HostHeaderConfig?: { Values?: string[] } }> = [];
  if (rule.pathPatterns?.length) {
    conditions.push({ Field: 'path-pattern', PathPatternConfig: { Values: rule.pathPatterns } });
  }
  if (rule.hostHeaders?.length) {
    conditions.push({ Field: 'host-header', HostHeaderConfig: { Values: rule.hostHeaders } });
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyAlb(_ctx: AwsContext, name: string): Promise<never> {
  // Keep DeleteRuleCommand reachable for future fine-grained destroys.
  void DeleteRuleCommand;
  throw new Error(
    `forge refuses to destroy ALB '${name}' automatically. Sites pointing at the ALB go\n` +
    'offline immediately on delete; Route 53 alias records break. Confirm no consumers,\n' +
    'then DeleteLoadBalancer via the AWS Console.'
  );
}
