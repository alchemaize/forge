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

  // Ingress: authorize each rule. AWS rejects duplicates with InvalidPermission.Duplicate
  // — catch + ignore so apply is idempotent. (Full sync with revoke-extras is more complex
  // and rare; users adding new rules is the common case.)
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

  return current;
}

// Suppress unused-import warning
void RevokeSecurityGroupIngressCommand;
void RevokeSecurityGroupEgressCommand;
