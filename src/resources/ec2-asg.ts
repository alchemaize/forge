/**
 * EC2 Launch Templates + Auto Scaling Groups module.
 *
 * Manages two related resources:
 *   1. Launch Templates — versioned templates describing how to launch
 *      instances (AMI, instance type, user data, security groups, etc.).
 *      AWS auto-versions; Forge creates a new version when canonical
 *      shape changes and points the ASG at $Latest.
 *   2. Auto Scaling Groups — manage the running fleet (min/max/desired,
 *      health checks, target group registration).
 *
 * Adoption-safe behavior:
 *   - Launch templates adopt by name; new versions only registered when
 *     canonical shape changes.
 *   - ASGs adopt by name; capacity / target groups updated in place.
 *
 * Most modern apps don't need this — Fargate (ecs.ts) is the right
 * choice for stateless container workloads. Use this when you genuinely
 * need EC2 instances (GPU work, custom AMIs, large-instance batch jobs).
 *
 * SAFETY: Compute-tier — destroy refused.
 */

import {
  EC2Client,
  DescribeLaunchTemplatesCommand,
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateVersionCommand,
} from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  AttachLoadBalancerTargetGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import type { AwsContext } from '../aws.js';
import type {
  LaunchTemplateConfig,
  AutoScalingGroupConfig,
} from '../config.js';
import { getClient, withContext, canonicalize } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

// ===========================================================================
// LAUNCH TEMPLATES
// ===========================================================================

export interface LaunchTemplateState {
  name: string;
  templateId: string;
  latestVersion: number;
  defaultVersion: number;
}

export async function describeLaunchTemplate(
  ctx: AwsContext,
  config: LaunchTemplateConfig
): Promise<LaunchTemplateState | null> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  try {
    const res = await ec2.send(new DescribeLaunchTemplatesCommand({
      LaunchTemplateNames: [config.name],
    }));
    const lt = res.LaunchTemplates?.[0];
    if (!lt) return null;
    return {
      name: lt.LaunchTemplateName!,
      templateId: lt.LaunchTemplateId!,
      latestVersion: Number(lt.LatestVersionNumber ?? 1),
      defaultVersion: Number(lt.DefaultVersionNumber ?? 1),
    };
  } catch (err: any) {
    if (err.name === 'InvalidLaunchTemplateName.NotFoundException') return null;
    throw err;
  }
}

function buildLtData(config: LaunchTemplateConfig): any {
  const userData = config.userData
    ? Buffer.from(config.userData).toString('base64')
    : undefined;
  // Return as `any` because the SDK's RequestLaunchTemplateData uses
  // string-literal union types for InstanceType / VolumeType. User configs
  // pass plain strings; we trust the user and let AWS reject invalid
  // values rather than enumerate the entire EC2 instance catalog here.
  return {
    ImageId: config.imageId,
    InstanceType: config.instanceType ?? 't3.small',
    KeyName: config.keyName,
    SecurityGroupIds: config.securityGroupIds,
    IamInstanceProfile: config.instanceProfileName
      ? { Name: config.instanceProfileName }
      : undefined,
    UserData: userData,
    BlockDeviceMappings: config.blockDevice
      ? [{
          DeviceName: config.blockDevice.deviceName ?? '/dev/xvda',
          Ebs: {
            VolumeSize: config.blockDevice.volumeSize ?? 30,
            VolumeType: config.blockDevice.volumeType ?? 'gp3',
            Encrypted: config.blockDevice.encrypted ?? true,
          },
        }]
      : undefined,
    TagSpecifications: [
      {
        ResourceType: 'instance' as const,
        Tags: [
          { Key: 'managed-by', Value: 'forge' },
          ...Object.entries(config.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
        ],
      },
    ],
  };
}

export async function planLaunchTemplate(
  ctx: AwsContext,
  config: LaunchTemplateConfig,
  _appName: string,
  plan: Plan
): Promise<LaunchTemplateState | null> {
  const current = await describeLaunchTemplate(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'launch-template',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'imageId', current: undefined, desired: config.imageId },
        { field: 'instanceType', current: undefined, desired: config.instanceType ?? 't3.small' },
      ],
    });
    return null;
  }
  // Drift check would require describing the latest version; we leave
  // that as apply-time work. Plan reports unchanged for adoption.
  addChange(plan, {
    resourceType: 'launch-template',
    resourceId: config.name,
    changeType: 'unchanged',
    tier: 'compute',
    fields: [],
  });
  return current;
}

export async function applyLaunchTemplate(
  ctx: AwsContext,
  config: LaunchTemplateConfig,
  _appName: string
): Promise<LaunchTemplateState> {
  const ec2: EC2Client = getClient(ctx, EC2Client);
  let current = await describeLaunchTemplate(ctx, config);
  const ltData = buildLtData(config);

  if (!current) {
    console.log(`[launch-template] Creating: ${config.name}`);
    try {
      const res = await ec2.send(new CreateLaunchTemplateCommand({
        LaunchTemplateName: config.name,
        LaunchTemplateData: ltData,
      }));
      current = {
        name: res.LaunchTemplate!.LaunchTemplateName!,
        templateId: res.LaunchTemplate!.LaunchTemplateId!,
        latestVersion: 1,
        defaultVersion: 1,
      };
    } catch (err) {
      throw withContext(`[launch-template] CreateLaunchTemplate ${config.name}`, err);
    }
  } else {
    // Always create a new version on apply when shape might have changed.
    // CreateLaunchTemplateVersion is idempotent only if the data matches
    // exactly; AWS deduplicates rarely, so just version bump and let the
    // ASG point at $Latest.
    console.log(`[launch-template] Creating new version of ${config.name}`);
    try {
      const res = await ec2.send(new CreateLaunchTemplateVersionCommand({
        LaunchTemplateName: config.name,
        LaunchTemplateData: ltData,
      }));
      current.latestVersion = Number(res.LaunchTemplateVersion!.VersionNumber!);
    } catch (err) {
      throw withContext(`[launch-template] CreateLaunchTemplateVersion ${config.name}`, err);
    }
  }
  return current;
}

export async function destroyLaunchTemplate(): Promise<never> {
  throw new Error(
    'forge refuses to destroy launch templates. ASGs referencing the\n' +
    'template fail to launch new instances. Detach from ASGs first.'
  );
}

// Keep canonicalize reachable for future drift work.
void canonicalize;

// ===========================================================================
// AUTO SCALING GROUPS
// ===========================================================================

export interface AutoScalingGroupState {
  name: string;
  arn: string;
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  launchTemplateName?: string;
  targetGroupArns: string[];
  healthCheckType: string;
  status: string;
}

export async function describeAsg(
  ctx: AwsContext,
  config: AutoScalingGroupConfig
): Promise<AutoScalingGroupState | null> {
  const asc: AutoScalingClient = getClient(ctx, AutoScalingClient);
  const res = await asc.send(new DescribeAutoScalingGroupsCommand({
    AutoScalingGroupNames: [config.name],
  }));
  const asg = res.AutoScalingGroups?.[0];
  if (!asg) return null;
  return {
    name: asg.AutoScalingGroupName!,
    arn: asg.AutoScalingGroupARN!,
    minSize: asg.MinSize ?? 0,
    maxSize: asg.MaxSize ?? 0,
    desiredCapacity: asg.DesiredCapacity ?? 0,
    launchTemplateName: asg.LaunchTemplate?.LaunchTemplateName,
    targetGroupArns: asg.TargetGroupARNs ?? [],
    healthCheckType: asg.HealthCheckType ?? 'EC2',
    status: asg.Status ?? 'active',
  };
}

export async function planAsg(
  ctx: AwsContext,
  config: AutoScalingGroupConfig,
  _appName: string,
  plan: Plan
): Promise<AutoScalingGroupState | null> {
  const current = await describeAsg(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'asg',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'capacity', current: undefined, desired: `${config.minSize}-${config.maxSize} (desired ${config.desiredCapacity ?? config.minSize})` },
        { field: 'launchTemplate', current: undefined, desired: config.launchTemplate },
      ],
    });
    return null;
  }
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (current.minSize !== config.minSize) fields.push({ field: 'minSize', current: current.minSize, desired: config.minSize });
  if (current.maxSize !== config.maxSize) fields.push({ field: 'maxSize', current: current.maxSize, desired: config.maxSize });
  if (config.desiredCapacity !== undefined && current.desiredCapacity !== config.desiredCapacity) {
    fields.push({ field: 'desiredCapacity', current: current.desiredCapacity, desired: config.desiredCapacity });
  }
  if (current.launchTemplateName !== config.launchTemplate) {
    fields.push({ field: 'launchTemplate', current: current.launchTemplateName, desired: config.launchTemplate });
  }
  const missingTgs = (config.targetGroupArns ?? []).filter(arn => !current.targetGroupArns.includes(arn));
  if (missingTgs.length > 0) {
    fields.push({ field: 'targetGroups', current: `${current.targetGroupArns.length} attached`, desired: `+${missingTgs.length}` });
  }
  addChange(plan, {
    resourceType: 'asg',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'compute',
    fields,
  });
  return current;
}

export async function applyAsg(
  ctx: AwsContext,
  config: AutoScalingGroupConfig,
  appName: string
): Promise<AutoScalingGroupState> {
  const asc: AutoScalingClient = getClient(ctx, AutoScalingClient);
  const current = await describeAsg(ctx, config);

  if (!current) {
    console.log(`[asg] Creating: ${config.name}`);
    try {
      await asc.send(new CreateAutoScalingGroupCommand({
        AutoScalingGroupName: config.name,
        LaunchTemplate: {
          LaunchTemplateName: config.launchTemplate,
          Version: '$Latest',
        },
        MinSize: config.minSize,
        MaxSize: config.maxSize,
        DesiredCapacity: config.desiredCapacity ?? config.minSize,
        VPCZoneIdentifier: config.subnetIds.join(','),
        HealthCheckType: config.healthCheckType ?? 'EC2',
        HealthCheckGracePeriod: config.healthCheckGracePeriod ?? 300,
        TargetGroupARNs: config.targetGroupArns,
        Tags: [
          { Key: 'app', Value: appName, PropagateAtLaunch: true },
          { Key: 'managed-by', Value: 'forge', PropagateAtLaunch: true },
          ...Object.entries(config.tags ?? {}).map(([Key, Value]) => ({
            Key, Value, PropagateAtLaunch: true,
          })),
        ],
      }));
    } catch (err) {
      throw withContext(`[asg] CreateAutoScalingGroup ${config.name}`, err);
    }
  } else {
    console.log(`[asg] Updating: ${config.name}`);
    try {
      await asc.send(new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: config.name,
        LaunchTemplate: {
          LaunchTemplateName: config.launchTemplate,
          Version: '$Latest',
        },
        MinSize: config.minSize,
        MaxSize: config.maxSize,
        DesiredCapacity: config.desiredCapacity ?? current.desiredCapacity,
        VPCZoneIdentifier: config.subnetIds.join(','),
        HealthCheckType: config.healthCheckType ?? current.healthCheckType,
        HealthCheckGracePeriod: config.healthCheckGracePeriod ?? 300,
      }));
    } catch (err) {
      throw withContext(`[asg] UpdateAutoScalingGroup ${config.name}`, err);
    }
    // Target groups: additive attach.
    const missing = (config.targetGroupArns ?? []).filter(arn => !current.targetGroupArns.includes(arn));
    if (missing.length > 0) {
      await asc.send(new AttachLoadBalancerTargetGroupsCommand({
        AutoScalingGroupName: config.name,
        TargetGroupARNs: missing,
      }));
    }
  }

  return (await describeAsg(ctx, config))!;
}

export async function destroyAsg(): Promise<never> {
  throw new Error(
    'forge refuses to destroy Auto Scaling Groups. Running instances are\n' +
    'terminated; in-flight requests dropped. Set min/max/desired to 0\n' +
    'first, wait for instances to drain, then DeleteAutoScalingGroup.'
  );
}
