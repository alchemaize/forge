/**
 * VPC endpoints resource module.
 *
 * Two flavors of endpoint, both useful for different reasons:
 *
 *   1. Gateway endpoints (S3, DynamoDB only). Free. Attach to route
 *      tables; traffic to the service's prefix list goes private.
 *      The huge cost-saver for Lambda-in-VPC pulling Bedrock results
 *      to S3.
 *
 *   2. Interface endpoints (everything else). $7.20/mo per AZ ENI plus
 *      data transfer. Often required to keep a private-subnet Lambda
 *      from needing a NAT just to talk to ECR / Secrets Manager / KMS.
 *      A 3-AZ stack with 4 interface endpoints costs ~$86/mo, but
 *      saves the NAT processing fee (~$45/mo per GB) at any meaningful
 *      data volume.
 *
 * Forge expands a short alias ('s3', 'ecr.api') to the full regional
 * service name. Type defaults: s3 / dynamodb → Gateway, everything else
 * → Interface.
 *
 * Adoption-safe: existing endpoints in the same VPC for the same service
 * are adopted in place. Subnet / route table associations get reconciled
 * additively (Forge attaches missing, leaves extras alone).
 *
 * SAFETY: Compute-tier — destroy is allowed but breaks any private
 * traffic flowing through the endpoint, so Forge requires the resource
 * to be named explicitly.
 */

import {
  EC2Client,
  DescribeVpcEndpointsCommand,
  CreateVpcEndpointCommand,
  ModifyVpcEndpointCommand,
  DeleteVpcEndpointsCommand,
} from '@aws-sdk/client-ec2';
import type { AwsContext } from '../aws.js';
import type { VpcEndpointConfig, ForgeConfig } from '../config.js';
import { getClient, withContext, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface VpcEndpointState {
  endpointId: string;
  service: string;
  type: 'Gateway' | 'Interface';
  vpcId: string;
  state: string;
  routeTableIds: string[];
  subnetIds: string[];
  securityGroupIds: string[];
  privateDnsEnabled: boolean;
}

const GATEWAY_SERVICES = new Set(['s3', 'dynamodb']);

/**
 * Expand the short alias to a fully-qualified service name. Idempotent
 * for already-qualified names.
 */
function expandService(service: string, region: string): string {
  if (service.startsWith('com.amazonaws.')) return service;
  return `com.amazonaws.${region}.${service}`;
}

function inferType(service: string, override?: 'Gateway' | 'Interface'): 'Gateway' | 'Interface' {
  if (override) return override;
  return GATEWAY_SERVICES.has(service) ? 'Gateway' : 'Interface';
}

function resolveVpcId(
  config: VpcEndpointConfig,
  parentConfig?: ForgeConfig,
  vpcStateId?: string,
): string | undefined {
  if (config.vpcId) return config.vpcId;
  if (vpcStateId) return vpcStateId;
  if (parentConfig?.vpc?.mode === 'lookup' && parentConfig.vpc.vpcId) return parentConfig.vpc.vpcId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeVpcEndpoint(
  ctx: AwsContext,
  config: VpcEndpointConfig,
  parentConfig?: ForgeConfig,
  vpcStateId?: string,
): Promise<VpcEndpointState | null> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  const vpcId = resolveVpcId(config, parentConfig, vpcStateId);
  const service = expandService(config.service, ctx.region);

  if (!vpcId) return null;

  const res = await ec2.send(new DescribeVpcEndpointsCommand({
    Filters: [
      { Name: 'vpc-id', Values: [vpcId] },
      { Name: 'service-name', Values: [service] },
    ],
  }));
  const endpoint = res.VpcEndpoints?.[0];
  if (!endpoint) return null;

  return {
    endpointId: endpoint.VpcEndpointId!,
    service,
    type: (endpoint.VpcEndpointType ?? 'Interface') as 'Gateway' | 'Interface',
    vpcId,
    state: endpoint.State ?? 'available',
    routeTableIds: endpoint.RouteTableIds ?? [],
    subnetIds: endpoint.SubnetIds ?? [],
    securityGroupIds: (endpoint.Groups ?? []).map(g => g.GroupId!).filter(Boolean),
    privateDnsEnabled: endpoint.PrivateDnsEnabled ?? false,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planVpcEndpoint(
  ctx: AwsContext,
  config: VpcEndpointConfig,
  _appName: string,
  plan: Plan,
  parentConfig?: ForgeConfig,
): Promise<VpcEndpointState | null> {
  const current = await describeVpcEndpoint(ctx, config, parentConfig);
  const expandedService = expandService(config.service, ctx.region);
  const desiredType = inferType(config.service, config.type);

  if (!current) {
    addChange(plan, {
      resourceType: 'vpc-endpoint',
      resourceId: config.service,
      changeType: 'create',
      tier: 'config',
      fields: [
        { field: 'service', current: undefined, desired: expandedService },
        { field: 'type', current: undefined, desired: desiredType },
      ],
    });
    return null;
  }

  // Drift: subnet / route table association mismatches (additive — only
  // missing, not extras).
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (desiredType === 'Gateway' && config.routeTableIds?.length) {
    const missing = config.routeTableIds.filter(id => !current.routeTableIds.includes(id));
    if (missing.length > 0) {
      fields.push({
        field: 'routeTableIds',
        current: `${current.routeTableIds.length} associated`,
        desired: `+${missing.length} to add`,
      });
    }
  }
  if (desiredType === 'Interface') {
    if (config.subnetIds?.length) {
      const missing = config.subnetIds.filter(id => !current.subnetIds.includes(id));
      if (missing.length > 0) {
        fields.push({
          field: 'subnetIds',
          current: `${current.subnetIds.length} associated`,
          desired: `+${missing.length} to add`,
        });
      }
    }
    if (config.securityGroupIds?.length) {
      const missing = config.securityGroupIds.filter(id => !current.securityGroupIds.includes(id));
      if (missing.length > 0) {
        fields.push({
          field: 'securityGroupIds',
          current: `${current.securityGroupIds.length}`,
          desired: `+${missing.length}`,
        });
      }
    }
    if (config.privateDnsEnabled !== undefined && current.privateDnsEnabled !== config.privateDnsEnabled) {
      fields.push({ field: 'privateDnsEnabled', current: current.privateDnsEnabled, desired: config.privateDnsEnabled });
    }
  }
  if (config.policy && canonicalize(config.policy) !== canonicalize({})) {
    // Endpoint policy comparison would require a separate DescribeVpcEndpoints
    // call with PolicyDocument hydrated; we treat policy as opt-in for plan
    // visibility only and handle it on apply.
  }

  addChange(plan, {
    resourceType: 'vpc-endpoint',
    resourceId: config.service,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyVpcEndpoint(
  ctx: AwsContext,
  config: VpcEndpointConfig,
  _appName: string,
  parentConfig?: ForgeConfig,
  vpcStateId?: string,
): Promise<VpcEndpointState> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  const vpcId = resolveVpcId(config, parentConfig, vpcStateId);
  const service = expandService(config.service, ctx.region);
  const type = inferType(config.service, config.type);

  if (!vpcId) {
    throw new Error(`[vpc-endpoint] ${config.service}: no VPC ID available. Set config.vpcId or declare a vpc block.`);
  }

  let current = await describeVpcEndpoint(ctx, config, parentConfig, vpcStateId);
  if (!current) {
    console.log(`[vpc-endpoint] Creating ${type} endpoint: ${service} (vpc=${vpcId})`);
    try {
      const res = await ec2.send(new CreateVpcEndpointCommand({
        VpcId: vpcId,
        ServiceName: service,
        VpcEndpointType: type,
        RouteTableIds: type === 'Gateway' ? config.routeTableIds : undefined,
        SubnetIds: type === 'Interface' ? config.subnetIds : undefined,
        SecurityGroupIds: type === 'Interface' ? config.securityGroupIds : undefined,
        PrivateDnsEnabled: type === 'Interface' ? (config.privateDnsEnabled ?? true) : undefined,
        PolicyDocument: config.policy ? JSON.stringify(config.policy) : undefined,
      }));
      const endpointId = res.VpcEndpoint!.VpcEndpointId!;
      console.log(`[vpc-endpoint] Created: ${endpointId}`);
      return {
        endpointId,
        service,
        type,
        vpcId,
        state: res.VpcEndpoint!.State ?? 'pending',
        routeTableIds: res.VpcEndpoint!.RouteTableIds ?? [],
        subnetIds: res.VpcEndpoint!.SubnetIds ?? [],
        securityGroupIds: (res.VpcEndpoint!.Groups ?? []).map(g => g.GroupId!).filter(Boolean),
        privateDnsEnabled: res.VpcEndpoint!.PrivateDnsEnabled ?? false,
      };
    } catch (err) {
      throw withContext(`[vpc-endpoint] CreateVpcEndpoint ${service}`, err);
    }
  }

  // Adoption: reconcile additive associations / DNS setting.
  const params: Record<string, unknown> = { VpcEndpointId: current.endpointId };
  let needsModify = false;
  if (type === 'Gateway' && config.routeTableIds?.length) {
    const missing = config.routeTableIds.filter(id => !current!.routeTableIds.includes(id));
    if (missing.length > 0) { params.AddRouteTableIds = missing; needsModify = true; }
  }
  if (type === 'Interface') {
    if (config.subnetIds?.length) {
      const missing = config.subnetIds.filter(id => !current!.subnetIds.includes(id));
      if (missing.length > 0) { params.AddSubnetIds = missing; needsModify = true; }
    }
    if (config.securityGroupIds?.length) {
      const missing = config.securityGroupIds.filter(id => !current!.securityGroupIds.includes(id));
      if (missing.length > 0) { params.AddSecurityGroupIds = missing; needsModify = true; }
    }
    if (config.privateDnsEnabled !== undefined && current.privateDnsEnabled !== config.privateDnsEnabled) {
      params.PrivateDnsEnabled = config.privateDnsEnabled;
      needsModify = true;
    }
  }

  if (needsModify) {
    console.log(`[vpc-endpoint] Modifying: ${service}`);
    try {
      await ec2.send(new ModifyVpcEndpointCommand(params as any));
    } catch (err) {
      throw withContext(`[vpc-endpoint] ModifyVpcEndpoint ${service}`, err);
    }
    current = (await describeVpcEndpoint(ctx, config, parentConfig, vpcStateId))!;
  }

  return current;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyVpcEndpoint(ctx: AwsContext, idOrService: string): Promise<void> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  // Accept either the endpoint ID or the short service alias (in which
  // case look it up across all VPCs).
  let endpointId = idOrService;
  if (!endpointId.startsWith('vpce-')) {
    const service = expandService(idOrService, ctx.region);
    const res = await ec2.send(new DescribeVpcEndpointsCommand({
      Filters: [{ Name: 'service-name', Values: [service] }],
    }));
    if (!res.VpcEndpoints?.length) {
      throw new Error(`[vpc-endpoint] No endpoint found for service '${idOrService}'.`);
    }
    if (res.VpcEndpoints.length > 1) {
      throw new Error(`[vpc-endpoint] ${res.VpcEndpoints.length} endpoints match service '${idOrService}'. Pass the endpoint ID directly to disambiguate.`);
    }
    endpointId = res.VpcEndpoints[0].VpcEndpointId!;
  }
  await ec2.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: [endpointId] }));
  console.log(`[vpc-endpoint] Deleted: ${endpointId}`);
}
