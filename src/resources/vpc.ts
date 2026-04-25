/**
 * VPC resource module.
 *
 * Supports two modes:
 * - lookup: reference an existing VPC by ID (most common — VPCs are created once)
 * - create: provision a new VPC with standard subnet layout
 *
 * SAFETY: forge destroy REFUSES on VPC resources. Manual deletion only.
 */

import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeNatGatewaysCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  CreateVpcCommand,
  CreateSubnetCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  CreateNatGatewayCommand,
  AllocateAddressCommand,
  CreateRouteTableCommand,
  CreateRouteCommand,
  AssociateRouteTableCommand,
  ModifyVpcAttributeCommand,
  CreateTagsCommand,
  CreateSecurityGroupCommand,
  DescribeAvailabilityZonesCommand,
} from '@aws-sdk/client-ec2';
import type { AwsContext } from '../aws.js';
import type { VpcConfig } from '../config.js';
import { getClient } from '../aws.js';
import { addChange, type Plan, type ResourceChange } from '../diff.js';

export interface VpcState {
  vpcId: string;
  cidr: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];
  isolatedSubnetIds: string[];
  natGatewayId?: string;
  internetGatewayId?: string;
  securityGroupIds: {
    default: string;
    lambda?: string;
    rdsProxy?: string;
    rds?: string;
  };
}

/**
 * Read current VPC state from AWS.
 */
export async function describeVpc(
  ctx: AwsContext,
  config: VpcConfig,
  appName: string
): Promise<VpcState | null> {
  const ec2 = getClient(ctx, EC2Client);

  if (config.mode === 'lookup') {
    if (!config.vpcId) throw new Error('VPC lookup mode requires vpcId');

    const res = await ec2.send(new DescribeVpcsCommand({ VpcIds: [config.vpcId] }));
    const vpc = res.Vpcs?.[0];
    if (!vpc) return null;

    // Get subnets
    const subnetsRes = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: 'vpc-id', Values: [config.vpcId] }],
    }));
    const subnets = subnetsRes.Subnets ?? [];

    const publicSubnetIds: string[] = [];
    const privateSubnetIds: string[] = [];
    const isolatedSubnetIds: string[] = [];

    for (const subnet of subnets) {
      const nameTag = subnet.Tags?.find(t => t.Key === 'Name')?.Value ?? '';
      const id = subnet.SubnetId!;
      if (nameTag.includes('Public') || nameTag.includes('public') || subnet.MapPublicIpOnLaunch) {
        publicSubnetIds.push(id);
      } else if (nameTag.includes('Private') || nameTag.includes('private')) {
        privateSubnetIds.push(id);
      } else if (nameTag.includes('Isolated') || nameTag.includes('isolated')) {
        isolatedSubnetIds.push(id);
      } else {
        // Default: if it has a route to NAT, it's private; if no route to IGW/NAT, isolated
        privateSubnetIds.push(id);
      }
    }

    // Get NAT gateway
    const natRes = await ec2.send(new DescribeNatGatewaysCommand({
      Filter: [
        { Name: 'vpc-id', Values: [config.vpcId] },
        { Name: 'state', Values: ['available'] },
      ],
    }));
    const natGatewayId = natRes.NatGateways?.[0]?.NatGatewayId;

    // Get IGW
    const igwRes = await ec2.send(new DescribeInternetGatewaysCommand({
      Filters: [{ Name: 'attachment.vpc-id', Values: [config.vpcId] }],
    }));
    const internetGatewayId = igwRes.InternetGateways?.[0]?.InternetGatewayId;

    // Get security groups
    const sgRes = await ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: 'vpc-id', Values: [config.vpcId] }],
    }));
    const sgs = sgRes.SecurityGroups ?? [];
    const defaultSg = sgs.find(sg => sg.GroupName === 'default')?.GroupId ?? sgs[0]?.GroupId ?? '';
    const lambdaSg = sgs.find(sg => {
      const name = (sg.GroupName ?? '') + (sg.Tags?.find(t => t.Key === 'Name')?.Value ?? '');
      return name.toLowerCase().includes('lambda');
    })?.GroupId;
    const rdsProxySg = sgs.find(sg => {
      const name = (sg.GroupName ?? '') + (sg.Tags?.find(t => t.Key === 'Name')?.Value ?? '');
      return name.toLowerCase().includes('proxy');
    })?.GroupId;
    const rdsSg = sgs.find(sg => {
      const name = (sg.GroupName ?? '') + (sg.Tags?.find(t => t.Key === 'Name')?.Value ?? '');
      return name.toLowerCase().includes('rds') || name.toLowerCase().includes('database') || name.toLowerCase().includes('aurora');
    })?.GroupId;

    return {
      vpcId: config.vpcId,
      cidr: vpc.CidrBlock ?? '',
      publicSubnetIds,
      privateSubnetIds,
      isolatedSubnetIds,
      natGatewayId,
      internetGatewayId,
      securityGroupIds: { default: defaultSg, lambda: lambdaSg, rdsProxy: rdsProxySg, rds: rdsSg },
    };
  }

  // Create mode — check if VPC with our tag already exists
  const res = await ec2.send(new DescribeVpcsCommand({
    Filters: [
      { Name: 'tag:app', Values: [appName] },
      { Name: 'tag:managed-by', Values: ['forge'] },
    ],
  }));

  if (res.Vpcs && res.Vpcs.length > 0) {
    // Recurse with lookup mode
    return describeVpc(ctx, { mode: 'lookup', vpcId: res.Vpcs[0].VpcId! }, appName);
  }

  return null;
}

/**
 * Plan VPC changes.
 */
export async function planVpc(
  ctx: AwsContext,
  config: VpcConfig,
  appName: string,
  plan: Plan
): Promise<VpcState | null> {
  const current = await describeVpc(ctx, config, appName);

  if (config.mode === 'lookup') {
    if (current) {
      addChange(plan, {
        resourceType: 'vpc',
        resourceId: current.vpcId,
        changeType: 'unchanged',
        tier: 'data',
        fields: [],
      });
    } else {
      throw new Error(`VPC ${config.vpcId} not found. Cannot proceed with lookup mode.`);
    }
    return current;
  }

  // Create mode
  if (current) {
    addChange(plan, {
      resourceType: 'vpc',
      resourceId: current.vpcId,
      changeType: 'unchanged',
      tier: 'data',
      fields: [],
    });
    return current;
  }

  const cidr = config.cidr ?? '10.0.0.0/16';
  addChange(plan, {
    resourceType: 'vpc',
    resourceId: `${appName}-vpc`,
    changeType: 'create',
    tier: 'data',
    fields: [
      { field: 'cidr', current: undefined, desired: cidr },
      { field: 'azCount', current: undefined, desired: config.azCount ?? 2 },
      { field: 'natGateway', current: undefined, desired: config.natGateway ?? true },
      { field: 'subnetLayout', current: undefined, desired: config.subnetLayout ?? 'public-private-isolated' },
    ],
  });

  return null; // Will be created during apply
}

/**
 * Apply VPC changes — create if needed.
 */
export async function applyVpc(
  ctx: AwsContext,
  config: VpcConfig,
  appName: string
): Promise<VpcState> {
  // Check if already exists
  const existing = await describeVpc(ctx, config, appName);
  if (existing) {
    console.log(`[vpc] ${existing.vpcId} — no changes needed`);
    return existing;
  }

  if (config.mode === 'lookup') {
    throw new Error(`VPC ${config.vpcId} not found`);
  }

  const ec2 = getClient(ctx, EC2Client);
  const cidr = config.cidr ?? '10.0.0.0/16';
  const azCount = config.azCount ?? 2;
  const wantNat = config.natGateway ?? true;
  const layout = config.subnetLayout ?? 'public-private-isolated';

  // 1. Create VPC
  console.log(`[vpc] Creating VPC: ${cidr}`);
  const vpcRes = await ec2.send(new CreateVpcCommand({ CidrBlock: cidr }));
  const vpcId = vpcRes.Vpc!.VpcId!;

  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsSupport: { Value: true } }));
  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsHostnames: { Value: true } }));

  await ec2.send(new CreateTagsCommand({
    Resources: [vpcId],
    Tags: [
      { Key: 'Name', Value: `${appName}-vpc` },
      { Key: 'app', Value: appName },
      { Key: 'managed-by', Value: 'forge' },
    ],
  }));
  console.log(`[vpc] Created: ${vpcId}`);

  // 2. Get AZs
  const azRes = await ec2.send(new DescribeAvailabilityZonesCommand({
    Filters: [{ Name: 'state', Values: ['available'] }],
  }));
  const azs = (azRes.AvailabilityZones ?? []).slice(0, azCount).map(az => az.ZoneName!);

  // 3. Create Internet Gateway
  console.log('[vpc] Creating Internet Gateway');
  const igwRes = await ec2.send(new CreateInternetGatewayCommand({}));
  const igwId = igwRes.InternetGateway!.InternetGatewayId!;
  await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));
  await ec2.send(new CreateTagsCommand({
    Resources: [igwId],
    Tags: [{ Key: 'Name', Value: `${appName}-igw` }, { Key: 'app', Value: appName }],
  }));

  // 4. Create subnets
  const publicSubnetIds: string[] = [];
  const privateSubnetIds: string[] = [];
  const isolatedSubnetIds: string[] = [];

  // Subnet CIDR allocation: /20 blocks
  // Public: 10.0.0.0/20, 10.0.16.0/20
  // Private: 10.0.32.0/20, 10.0.48.0/20
  // Isolated: 10.0.64.0/20, 10.0.80.0/20
  const subnetConfigs: Array<{ type: string; ids: string[]; offset: number }> = [
    { type: 'Public', ids: publicSubnetIds, offset: 0 },
  ];
  if (layout !== 'public-only') {
    subnetConfigs.push({ type: 'Private', ids: privateSubnetIds, offset: 32 });
  }
  if (layout === 'public-private-isolated') {
    subnetConfigs.push({ type: 'Isolated', ids: isolatedSubnetIds, offset: 64 });
  }

  for (const sc of subnetConfigs) {
    for (let i = 0; i < azs.length; i++) {
      const thirdOctet = sc.offset + i * 16;
      const subnetCidr = `10.0.${thirdOctet}.0/20`;
      console.log(`[vpc] Creating ${sc.type} subnet in ${azs[i]}: ${subnetCidr}`);
      const subRes = await ec2.send(new CreateSubnetCommand({
        VpcId: vpcId,
        CidrBlock: subnetCidr,
        AvailabilityZone: azs[i],
        TagSpecifications: [{
          ResourceType: 'subnet',
          Tags: [
            { Key: 'Name', Value: `${appName}-${sc.type.toLowerCase()}-${azs[i]}` },
            { Key: 'app', Value: appName },
            { Key: 'managed-by', Value: 'forge' },
          ],
        }],
      }));
      sc.ids.push(subRes.Subnet!.SubnetId!);
    }
  }

  // 5. Public route table (routes to IGW)
  console.log('[vpc] Creating public route table');
  const pubRtRes = await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId }));
  const pubRtId = pubRtRes.RouteTable!.RouteTableId!;
  await ec2.send(new CreateRouteCommand({
    RouteTableId: pubRtId,
    DestinationCidrBlock: '0.0.0.0/0',
    GatewayId: igwId,
  }));
  await ec2.send(new CreateTagsCommand({
    Resources: [pubRtId],
    Tags: [{ Key: 'Name', Value: `${appName}-public-rt` }, { Key: 'app', Value: appName }],
  }));
  for (const subnetId of publicSubnetIds) {
    await ec2.send(new AssociateRouteTableCommand({ RouteTableId: pubRtId, SubnetId: subnetId }));
  }

  // 6. NAT Gateway (in first public subnet)
  let natGatewayId: string | undefined;
  if (wantNat && privateSubnetIds.length > 0) {
    console.log('[vpc] Allocating Elastic IP for NAT Gateway');
    const eipRes = await ec2.send(new AllocateAddressCommand({ Domain: 'vpc' }));
    const eipAllocId = eipRes.AllocationId!;

    console.log('[vpc] Creating NAT Gateway');
    const natRes = await ec2.send(new CreateNatGatewayCommand({
      SubnetId: publicSubnetIds[0],
      AllocationId: eipAllocId,
      TagSpecifications: [{
        ResourceType: 'natgateway',
        Tags: [
          { Key: 'Name', Value: `${appName}-nat` },
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
        ],
      }],
    }));
    natGatewayId = natRes.NatGateway!.NatGatewayId!;

    // Wait for NAT to become available
    console.log('[vpc] Waiting for NAT Gateway to become available...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const checkRes = await ec2.send(new DescribeNatGatewaysCommand({
        NatGatewayIds: [natGatewayId],
      }));
      const state = checkRes.NatGateways?.[0]?.State;
      if (state === 'available') {
        console.log('[vpc] NAT Gateway available');
        break;
      }
      if (state === 'failed') {
        throw new Error(`NAT Gateway creation failed: ${checkRes.NatGateways?.[0]?.FailureMessage}`);
      }
      console.log(`[vpc] NAT Gateway state: ${state} (${(i + 1) * 10}s)`);
    }

    // Private route table (routes to NAT)
    console.log('[vpc] Creating private route table');
    const privRtRes = await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId }));
    const privRtId = privRtRes.RouteTable!.RouteTableId!;
    await ec2.send(new CreateRouteCommand({
      RouteTableId: privRtId,
      DestinationCidrBlock: '0.0.0.0/0',
      NatGatewayId: natGatewayId,
    }));
    await ec2.send(new CreateTagsCommand({
      Resources: [privRtId],
      Tags: [{ Key: 'Name', Value: `${appName}-private-rt` }, { Key: 'app', Value: appName }],
    }));
    for (const subnetId of privateSubnetIds) {
      await ec2.send(new AssociateRouteTableCommand({ RouteTableId: privRtId, SubnetId: subnetId }));
    }
  }

  // 7. Security groups
  console.log('[vpc] Creating security groups');

  const lambdaSgRes = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: `${appName}-lambda-sg`,
    Description: `Lambda functions for ${appName}`,
    VpcId: vpcId,
    TagSpecifications: [{
      ResourceType: 'security-group',
      Tags: [
        { Key: 'Name', Value: `${appName}-lambda-sg` },
        { Key: 'app', Value: appName },
        { Key: 'managed-by', Value: 'forge' },
      ],
    }],
  }));
  const lambdaSgId = lambdaSgRes.GroupId!;

  const rdsProxySgRes = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: `${appName}-rds-proxy-sg`,
    Description: `RDS Proxy for ${appName} - allows inbound from Lambda SG on 5432`,
    VpcId: vpcId,
    TagSpecifications: [{
      ResourceType: 'security-group',
      Tags: [
        { Key: 'Name', Value: `${appName}-rds-proxy-sg` },
        { Key: 'app', Value: appName },
        { Key: 'managed-by', Value: 'forge' },
      ],
    }],
  }));
  const rdsProxySgId = rdsProxySgRes.GroupId!;

  const rdsSgRes = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: `${appName}-rds-sg`,
    Description: `RDS/Aurora for ${appName} - allows inbound from Proxy SG on 5432`,
    VpcId: vpcId,
    TagSpecifications: [{
      ResourceType: 'security-group',
      Tags: [
        { Key: 'Name', Value: `${appName}-rds-sg` },
        { Key: 'app', Value: appName },
        { Key: 'managed-by', Value: 'forge' },
      ],
    }],
  }));
  const rdsSgId = rdsSgRes.GroupId!;

  // SG rules: Lambda → RDS Proxy → RDS (port 5432)
  const { AuthorizeSecurityGroupIngressCommand } = await import('@aws-sdk/client-ec2');

  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: rdsProxySgId,
    IpPermissions: [{
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      UserIdGroupPairs: [{ GroupId: lambdaSgId }],
    }],
  }));

  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: rdsSgId,
    IpPermissions: [{
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      UserIdGroupPairs: [{ GroupId: rdsProxySgId }],
    }],
  }));

  // Get default SG
  const defaultSgRes = await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [
      { Name: 'vpc-id', Values: [vpcId] },
      { Name: 'group-name', Values: ['default'] },
    ],
  }));
  const defaultSgId = defaultSgRes.SecurityGroups?.[0]?.GroupId ?? '';

  console.log(`[vpc] Created VPC ${vpcId} with ${publicSubnetIds.length} public, ${privateSubnetIds.length} private, ${isolatedSubnetIds.length} isolated subnets`);

  return {
    vpcId,
    cidr,
    publicSubnetIds,
    privateSubnetIds,
    isolatedSubnetIds,
    natGatewayId,
    internetGatewayId: igwId,
    securityGroupIds: {
      default: defaultSgId,
      lambda: lambdaSgId,
      rdsProxy: rdsProxySgId,
      rds: rdsSgId,
    },
  };
}

/**
 * Destroy — REFUSED for VPC. Too dangerous.
 */
export async function destroyVpc(): Promise<never> {
  throw new Error(
    'forge refuses to destroy VPC resources. VPCs may be shared across multiple apps.\n' +
    'To delete a VPC, use the AWS Console or CLI manually after verifying no other resources depend on it.\n' +
    'Check: aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<VPC_ID>'
  );
}
