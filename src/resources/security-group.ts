/**
 * Security Group (standalone) resource module.
 *
 * Manages standalone security groups — the kind CDK creates explicitly via
 * `new ec2.SecurityGroup`. Distinct from the implicit Lambda-VPC-Proxy SG chain
 * inside vpc.ts (those are auto-managed for create-mode VPCs and not user-facing).
 *
 * Adoption-safe behavior:
 *   - Look up SG by name within the configured VPC.
 *   - If found, sync ingress/egress rules (add missing, revoke extras).
 *   - If not found, create it.
 *   - sourceSg references resolve to GroupId at apply time, so config can use
 *     friendly names instead of opaque sg-XXXX IDs.
 *
 * destroy: refused. Other resources (Lambda VPC config, RDS) reference SGs by ID;
 * deleting one breaks every Lambda/instance attached.
 */

import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  RevokeSecurityGroupEgressCommand,
} from '@aws-sdk/client-ec2';
import type { AwsContext } from '../aws.js';
import type { SecurityGroupConfig, SecurityGroupRule, ForgeConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface SecurityGroupState {
  groupId: string;
  groupName: string;
  vpcId: string;
  description: string;
  ingressCount: number;
  egressCount: number;
}

function resolveVpcId(config: SecurityGroupConfig, parentConfig?: ForgeConfig): string | undefined {
  if (config.vpcId) return config.vpcId;
  if (parentConfig?.vpc?.mode === 'lookup' && parentConfig.vpc.vpcId) return parentConfig.vpc.vpcId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeSecurityGroup(
  ctx: AwsContext,
  config: SecurityGroupConfig,
  parentConfig?: ForgeConfig
): Promise<SecurityGroupState | null> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  const vpcId = resolveVpcId(config, parentConfig);

  const filters: Array<{ Name: string; Values: string[] }> = [
    { Name: 'group-name', Values: [config.name] },
  ];
  if (vpcId) filters.push({ Name: 'vpc-id', Values: [vpcId] });

  try {
    const res = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: filters }));
    const sg = res.SecurityGroups?.[0];
    if (!sg) return null;
    return {
      groupId: sg.GroupId!,
      groupName: sg.GroupName!,
      vpcId: sg.VpcId ?? '',
      description: sg.Description ?? '',
      ingressCount: sg.IpPermissions?.length ?? 0,
      egressCount: sg.IpPermissionsEgress?.length ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planSecurityGroup(
  ctx: AwsContext,
  config: SecurityGroupConfig,
  _appName: string,
  plan: Plan,
  parentConfig?: ForgeConfig
): Promise<SecurityGroupState | null> {
  const current = await describeSecurityGroup(ctx, config, parentConfig);

  if (current) {
    addChange(plan, {
      resourceType: 'security-group',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'config',
      fields: [],
    });
    return current;
  }

  addChange(plan, {
    resourceType: 'security-group',
    resourceId: config.name,
    changeType: 'create',
    tier: 'config',
    fields: [
      { field: 'name', current: undefined, desired: config.name },
      { field: 'description', current: undefined, desired: config.description },
      { field: 'ingressRules', current: undefined, desired: config.ingress?.length ?? 0 },
    ],
  });
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Convert a Forge SG rule into the AWS IpPermission structure.
 * sourceSg references must already be resolved to GroupId by the caller.
 */
function ruleToIpPermission(rule: SecurityGroupRule, sourceSgId?: string): any {
  const perm: any = {
    IpProtocol: rule.protocol,
  };
  if (rule.protocol !== '-1') {
    perm.FromPort = rule.fromPort ?? 0;
    perm.ToPort = rule.toPort ?? rule.fromPort ?? 0;
  }
  if (rule.cidrIp) {
    perm.IpRanges = [{ CidrIp: rule.cidrIp, Description: rule.description }];
  } else if (sourceSgId) {
    perm.UserIdGroupPairs = [{ GroupId: sourceSgId, Description: rule.description }];
  }
  return perm;
}

export async function applySecurityGroup(
  ctx: AwsContext,
  config: SecurityGroupConfig,
  _appName: string,
  parentConfig?: ForgeConfig,
  /** Map of SG name → GroupId, populated as SGs are applied so subsequent SGs
   * can reference earlier ones via name. */
  sgNameMap?: Map<string, string>
): Promise<SecurityGroupState> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  const vpcId = resolveVpcId(config, parentConfig);
  if (!vpcId) {
    throw new Error(`[security-group] ${config.name}: no VPC ID available. Set config.vpcId or config.vpc.vpcId.`);
  }

  let current = await describeSecurityGroup(ctx, config, parentConfig);

  if (!current) {
    console.log(`[security-group] Creating: ${config.name}`);
    const createRes = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: config.name,
      Description: config.description,
      VpcId: vpcId,
    }));
    current = {
      groupId: createRes.GroupId!,
      groupName: config.name,
      vpcId,
      description: config.description,
      ingressCount: 0,
      egressCount: 1,  // AWS adds default allow-all egress on create
    };
  }

  if (sgNameMap) sgNameMap.set(config.name, current.groupId);

  // Ingress: authorize each rule. AWS rejects duplicates with
  // InvalidPermission.Duplicate, so the catch is the idempotency mechanism.
  for (const rule of config.ingress ?? []) {
    const sourceSgId = rule.sourceSg ? sgNameMap?.get(rule.sourceSg) : undefined;
    if (rule.sourceSg && !sourceSgId) {
      console.log(`[security-group] ${config.name}: skipping rule (sourceSg '${rule.sourceSg}' not yet applied)`);
      continue;
    }
    try {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: current.groupId,
        IpPermissions: [ruleToIpPermission(rule, sourceSgId)],
      }));
      console.log(`[security-group] ${config.name}: added ingress ${rule.protocol}:${rule.fromPort ?? '*'}`);
    } catch (err: any) {
      if (err.name !== 'InvalidPermission.Duplicate') {
        console.log(`[security-group] ${config.name}: ingress add warning: ${err.message}`);
      }
    }
  }

  for (const rule of config.egress ?? []) {
    const sourceSgId = rule.sourceSg ? sgNameMap?.get(rule.sourceSg) : undefined;
    try {
      await ec2.send(new AuthorizeSecurityGroupEgressCommand({
        GroupId: current.groupId,
        IpPermissions: [ruleToIpPermission(rule, sourceSgId)],
      }));
    } catch (err: any) {
      if (err.name !== 'InvalidPermission.Duplicate') {
        console.log(`[security-group] ${config.name}: egress add warning: ${err.message}`);
      }
    }
  }

  // Optional: revoke any live rule that's not in config. Off by default
  // for adoption safety — Forge won't yank rules it didn't know about.
  // Turn on for security-critical groups where config is the source of
  // truth (public ALB ingress, sensitive bastion ingress, etc.).
  if (config.pruneRules) {
    await pruneExtraRules(ec2, current.groupId, config, sgNameMap);
  }

  return current;
}

/**
 * Compare live ingress/egress rules to the config and revoke anything
 * not declared. Compares structurally on (protocol, fromPort, toPort,
 * cidrIp, sourceGroupId). Revokes are idempotent.
 */
async function pruneExtraRules(
  ec2: EC2Client,
  groupId: string,
  config: SecurityGroupConfig,
  sgNameMap?: Map<string, string>
): Promise<void> {
  // Re-describe to get the current rule set (we may have just added rules
  // a few ms ago).
  const desc = await ec2.send(new DescribeSecurityGroupsCommand({
    GroupIds: [groupId],
  }));
  const sg = desc.SecurityGroups?.[0];
  if (!sg) return;

  // Build a set of "rule signatures" from config so we can check live
  // rules against it. Each AWS IpPermission can contain multiple
  // IpRanges + UserIdGroupPairs, so we expand them out one signature
  // per (perm × range) when comparing.
  const sigOf = (
    protocol: string,
    fromPort: number | undefined,
    toPort: number | undefined,
    src: string
  ): string => `${protocol}|${fromPort ?? ''}|${toPort ?? ''}|${src}`;

  const desiredSigs = new Set<string>();
  for (const rule of config.ingress ?? []) {
    const sourceSgId = rule.sourceSg ? sgNameMap?.get(rule.sourceSg) : undefined;
    const src = rule.cidrIp ?? sourceSgId ?? '';
    if (!src) continue;
    desiredSigs.add(sigOf(
      rule.protocol,
      rule.protocol === '-1' ? undefined : (rule.fromPort ?? 0),
      rule.protocol === '-1' ? undefined : (rule.toPort ?? rule.fromPort ?? 0),
      src,
    ));
  }
  const desiredEgressSigs = new Set<string>();
  for (const rule of config.egress ?? []) {
    const sourceSgId = rule.sourceSg ? sgNameMap?.get(rule.sourceSg) : undefined;
    const src = rule.cidrIp ?? sourceSgId ?? '';
    if (!src) continue;
    desiredEgressSigs.add(sigOf(
      rule.protocol,
      rule.protocol === '-1' ? undefined : (rule.fromPort ?? 0),
      rule.protocol === '-1' ? undefined : (rule.toPort ?? rule.fromPort ?? 0),
      src,
    ));
  }

  // Walk live ingress; revoke anything not in desiredSigs.
  for (const perm of sg.IpPermissions ?? []) {
    const protocol = perm.IpProtocol ?? '-1';
    const fromPort = perm.FromPort;
    const toPort = perm.ToPort;
    for (const range of perm.IpRanges ?? []) {
      const sig = sigOf(protocol, fromPort, toPort, range.CidrIp ?? '');
      if (!desiredSigs.has(sig)) {
        console.log(`[security-group] ${config.name}: revoking ingress ${protocol}:${fromPort ?? '*'}-${toPort ?? '*'} from ${range.CidrIp}`);
        await ec2.send(new RevokeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [{
            IpProtocol: protocol,
            ...(fromPort !== undefined ? { FromPort: fromPort } : {}),
            ...(toPort !== undefined ? { ToPort: toPort } : {}),
            IpRanges: [{ CidrIp: range.CidrIp }],
          }],
        })).catch((err: any) => {
          if (err.name !== 'InvalidPermission.NotFound') throw err;
        });
      }
    }
    for (const pair of perm.UserIdGroupPairs ?? []) {
      const sig = sigOf(protocol, fromPort, toPort, pair.GroupId ?? '');
      if (!desiredSigs.has(sig)) {
        console.log(`[security-group] ${config.name}: revoking ingress ${protocol}:${fromPort ?? '*'}-${toPort ?? '*'} from ${pair.GroupId}`);
        await ec2.send(new RevokeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [{
            IpProtocol: protocol,
            ...(fromPort !== undefined ? { FromPort: fromPort } : {}),
            ...(toPort !== undefined ? { ToPort: toPort } : {}),
            UserIdGroupPairs: [{ GroupId: pair.GroupId }],
          }],
        })).catch((err: any) => {
          if (err.name !== 'InvalidPermission.NotFound') throw err;
        });
      }
    }
  }

  // Walk live egress; revoke anything not in desiredEgressSigs. Skip if
  // config has no egress declared (leaves AWS's default allow-all alone).
  if ((config.egress?.length ?? 0) > 0) {
    for (const perm of sg.IpPermissionsEgress ?? []) {
      const protocol = perm.IpProtocol ?? '-1';
      const fromPort = perm.FromPort;
      const toPort = perm.ToPort;
      for (const range of perm.IpRanges ?? []) {
        const sig = sigOf(protocol, fromPort, toPort, range.CidrIp ?? '');
        if (!desiredEgressSigs.has(sig)) {
          console.log(`[security-group] ${config.name}: revoking egress ${protocol}:${fromPort ?? '*'}-${toPort ?? '*'} to ${range.CidrIp}`);
          await ec2.send(new RevokeSecurityGroupEgressCommand({
            GroupId: groupId,
            IpPermissions: [{
              IpProtocol: protocol,
              ...(fromPort !== undefined ? { FromPort: fromPort } : {}),
              ...(toPort !== undefined ? { ToPort: toPort } : {}),
              IpRanges: [{ CidrIp: range.CidrIp }],
            }],
          })).catch((err: any) => {
            if (err.name !== 'InvalidPermission.NotFound') throw err;
          });
        }
      }
      for (const pair of perm.UserIdGroupPairs ?? []) {
        const sig = sigOf(protocol, fromPort, toPort, pair.GroupId ?? '');
        if (!desiredEgressSigs.has(sig)) {
          console.log(`[security-group] ${config.name}: revoking egress ${protocol}:${fromPort ?? '*'}-${toPort ?? '*'} to ${pair.GroupId}`);
          await ec2.send(new RevokeSecurityGroupEgressCommand({
            GroupId: groupId,
            IpPermissions: [{
              IpProtocol: protocol,
              ...(fromPort !== undefined ? { FromPort: fromPort } : {}),
              ...(toPort !== undefined ? { ToPort: toPort } : {}),
              UserIdGroupPairs: [{ GroupId: pair.GroupId }],
            }],
          })).catch((err: any) => {
            if (err.name !== 'InvalidPermission.NotFound') throw err;
          });
        }
      }
    }
  }
}
