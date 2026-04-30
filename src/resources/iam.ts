/**
 * IAM standalone resources module.
 *
 * Distinct from the inline-policy / role logic that lives inside
 * `lambda.ts` and `iam-managed-policy.ts`. This module manages
 * user-level and group-level IAM resources plus instance profiles for
 * EC2.
 *
 * Adoption-safe behavior:
 *   - Users / groups / instance profiles adopt by name.
 *   - Managed policy attachments reconcile additively (Forge attaches
 *     missing, never detaches policies it didn't put there).
 *   - Group memberships reconcile additively.
 *
 * SAFETY: Compute-tier — destroy refused for users (could lock people
 * out), allowed but lifted for instance profiles (attached EC2 instances
 * stop launching).
 */

import {
  IAMClient,
  GetUserCommand,
  CreateUserCommand,
  DeleteUserCommand,
  ListAttachedUserPoliciesCommand,
  AttachUserPolicyCommand,
  ListGroupsForUserCommand,
  AddUserToGroupCommand,
  GetGroupCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListAttachedGroupPoliciesCommand,
  AttachGroupPolicyCommand,
  GetInstanceProfileCommand,
  CreateInstanceProfileCommand,
  DeleteInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
  TagUserCommand,
} from '@aws-sdk/client-iam';
import type { AwsContext } from '../aws.js';
import type {
  IamUserConfig,
  IamGroupConfig,
  IamInstanceProfileConfig,
} from '../config.js';
import { getClient, withContext } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

// ===========================================================================
// USERS
// ===========================================================================

export interface IamUserState {
  userName: string;
  userArn: string;
  attachedPolicies: string[];
  groups: string[];
}

export async function describeIamUser(
  ctx: AwsContext,
  config: IamUserConfig
): Promise<IamUserState | null> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  try {
    const res = await iam.send(new GetUserCommand({ UserName: config.name }));
    if (!res.User) return null;
    const policies = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: config.name }));
    const groups = await iam.send(new ListGroupsForUserCommand({ UserName: config.name }));
    return {
      userName: res.User.UserName!,
      userArn: res.User.Arn!,
      attachedPolicies: (policies.AttachedPolicies ?? []).map(p => p.PolicyArn!).filter(Boolean),
      groups: (groups.Groups ?? []).map(g => g.GroupName!).filter(Boolean),
    };
  } catch (err: any) {
    if (err.name === 'NoSuchEntityException') return null;
    throw err;
  }
}

export async function planIamUser(
  ctx: AwsContext,
  config: IamUserConfig,
  _appName: string,
  plan: Plan
): Promise<IamUserState | null> {
  const current = await describeIamUser(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'iam-user',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [
        { field: 'managedPolicies', current: undefined, desired: config.managedPolicies?.length ?? 0 },
        { field: 'groups', current: undefined, desired: config.groups?.length ?? 0 },
      ],
    });
    return null;
  }
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  const missingPolicies = (config.managedPolicies ?? []).filter(p => !current.attachedPolicies.includes(p));
  if (missingPolicies.length > 0) {
    fields.push({ field: 'managedPolicies', current: `${current.attachedPolicies.length} attached`, desired: `+${missingPolicies.length}` });
  }
  const missingGroups = (config.groups ?? []).filter(g => !current.groups.includes(g));
  if (missingGroups.length > 0) {
    fields.push({ field: 'groups', current: current.groups.join(',') || 'none', desired: `+${missingGroups.join(',')}` });
  }
  addChange(plan, {
    resourceType: 'iam-user',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

export async function applyIamUser(
  ctx: AwsContext,
  config: IamUserConfig,
  appName: string
): Promise<IamUserState> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  let current = await describeIamUser(ctx, config);
  if (!current) {
    console.log(`[iam-user] Creating user: ${config.name}`);
    try {
      await iam.send(new CreateUserCommand({
        UserName: config.name,
        Path: config.path ?? '/',
        Tags: [
          { Key: 'app', Value: appName },
          { Key: 'managed-by', Value: 'forge' },
          ...Object.entries(config.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
        ],
      }));
    } catch (err) {
      throw withContext(`[iam-user] CreateUser ${config.name}`, err);
    }
    current = (await describeIamUser(ctx, config))!;
  } else if (config.tags && Object.keys(config.tags).length > 0) {
    // Tags can be added without recreating; AWS appends.
    await iam.send(new TagUserCommand({
      UserName: config.name,
      Tags: Object.entries(config.tags).map(([Key, Value]) => ({ Key, Value })),
    })).catch(() => undefined);
  }

  // Attach managed policies that are missing.
  for (const policyArn of config.managedPolicies ?? []) {
    if (current.attachedPolicies.includes(policyArn)) continue;
    console.log(`[iam-user] ${config.name}: attaching ${policyArn.split('/').pop()}`);
    await iam.send(new AttachUserPolicyCommand({ UserName: config.name, PolicyArn: policyArn }));
  }

  // Add to groups that are missing.
  for (const groupName of config.groups ?? []) {
    if (current.groups.includes(groupName)) continue;
    console.log(`[iam-user] ${config.name}: adding to group ${groupName}`);
    await iam.send(new AddUserToGroupCommand({
      UserName: config.name,
      GroupName: groupName,
    })).catch(err => {
      // NoSuchEntity for group-not-found surfaces helpfully via withContext.
      throw withContext(`[iam-user] AddUserToGroup ${groupName}`, err);
    });
  }

  return (await describeIamUser(ctx, config))!;
}

export async function destroyIamUser(_ctx: AwsContext, name: string): Promise<never> {
  // Keep DeleteUserCommand reachable for future explicit-cleanup flow.
  void DeleteUserCommand;
  throw new Error(
    `forge refuses to destroy IAM user '${name}'. Deletion is irreversible\n` +
    'and could lock out a real human. Detach policies, remove from groups,\n' +
    'rotate credentials, then DeleteUser via AWS Console or CLI.'
  );
}

// ===========================================================================
// GROUPS
// ===========================================================================

export interface IamGroupState {
  groupName: string;
  groupArn: string;
  attachedPolicies: string[];
}

export async function describeIamGroup(
  ctx: AwsContext,
  config: IamGroupConfig
): Promise<IamGroupState | null> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  try {
    const res = await iam.send(new GetGroupCommand({ GroupName: config.name }));
    if (!res.Group) return null;
    const policies = await iam.send(new ListAttachedGroupPoliciesCommand({ GroupName: config.name }));
    return {
      groupName: res.Group.GroupName!,
      groupArn: res.Group.Arn!,
      attachedPolicies: (policies.AttachedPolicies ?? []).map(p => p.PolicyArn!).filter(Boolean),
    };
  } catch (err: any) {
    if (err.name === 'NoSuchEntityException') return null;
    throw err;
  }
}

export async function planIamGroup(
  ctx: AwsContext,
  config: IamGroupConfig,
  _appName: string,
  plan: Plan
): Promise<IamGroupState | null> {
  const current = await describeIamGroup(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'iam-group',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [{ field: 'managedPolicies', current: undefined, desired: config.managedPolicies?.length ?? 0 }],
    });
    return null;
  }
  const missing = (config.managedPolicies ?? []).filter(p => !current.attachedPolicies.includes(p));
  addChange(plan, {
    resourceType: 'iam-group',
    resourceId: config.name,
    changeType: missing.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields: missing.length > 0
      ? [{ field: 'managedPolicies', current: `${current.attachedPolicies.length} attached`, desired: `+${missing.length}` }]
      : [],
  });
  return current;
}

export async function applyIamGroup(
  ctx: AwsContext,
  config: IamGroupConfig,
  _appName: string
): Promise<IamGroupState> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  let current = await describeIamGroup(ctx, config);
  if (!current) {
    console.log(`[iam-group] Creating: ${config.name}`);
    try {
      await iam.send(new CreateGroupCommand({
        GroupName: config.name,
        Path: config.path ?? '/',
      }));
    } catch (err) {
      throw withContext(`[iam-group] CreateGroup ${config.name}`, err);
    }
    current = (await describeIamGroup(ctx, config))!;
  }
  for (const policyArn of config.managedPolicies ?? []) {
    if (current.attachedPolicies.includes(policyArn)) continue;
    console.log(`[iam-group] ${config.name}: attaching ${policyArn.split('/').pop()}`);
    await iam.send(new AttachGroupPolicyCommand({ GroupName: config.name, PolicyArn: policyArn }));
  }
  return (await describeIamGroup(ctx, config))!;
}

export async function destroyIamGroup(): Promise<never> {
  void DeleteGroupCommand;
  throw new Error(
    'forge refuses to destroy IAM groups. Members lose policy attachments\n' +
    'silently. Remove members and detach policies first, then DeleteGroup.'
  );
}

// ===========================================================================
// INSTANCE PROFILES
// ===========================================================================

export interface InstanceProfileState {
  name: string;
  arn: string;
  roles: string[];
}

export async function describeInstanceProfile(
  ctx: AwsContext,
  config: IamInstanceProfileConfig
): Promise<InstanceProfileState | null> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  try {
    const res = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: config.name }));
    const ip = res.InstanceProfile;
    if (!ip) return null;
    return {
      name: ip.InstanceProfileName!,
      arn: ip.Arn!,
      roles: (ip.Roles ?? []).map(r => r.RoleName!).filter(Boolean),
    };
  } catch (err: any) {
    if (err.name === 'NoSuchEntityException') return null;
    throw err;
  }
}

export async function planInstanceProfile(
  ctx: AwsContext,
  config: IamInstanceProfileConfig,
  _appName: string,
  plan: Plan
): Promise<InstanceProfileState | null> {
  const current = await describeInstanceProfile(ctx, config);
  if (!current) {
    addChange(plan, {
      resourceType: 'iam-instance-profile',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [{ field: 'roleName', current: undefined, desired: config.roleName }],
    });
    return null;
  }
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (!current.roles.includes(config.roleName)) {
    fields.push({ field: 'roleName', current: current.roles.join(',') || 'none', desired: config.roleName });
  }
  addChange(plan, {
    resourceType: 'iam-instance-profile',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

export async function applyInstanceProfile(
  ctx: AwsContext,
  config: IamInstanceProfileConfig,
  _appName: string
): Promise<InstanceProfileState> {
  const iam: IAMClient = getClient(ctx, IAMClient);
  let current = await describeInstanceProfile(ctx, config);

  if (!current) {
    console.log(`[iam-instance-profile] Creating: ${config.name}`);
    try {
      await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: config.name }));
    } catch (err) {
      throw withContext(`[iam-instance-profile] CreateInstanceProfile ${config.name}`, err);
    }
    current = { name: config.name, arn: '', roles: [] };
  }

  // An instance profile can have at most one role; reconcile by removing
  // the wrong one and adding the right one if needed.
  if (!current.roles.includes(config.roleName)) {
    for (const roleName of current.roles) {
      console.log(`[iam-instance-profile] ${config.name}: removing role ${roleName}`);
      await iam.send(new RemoveRoleFromInstanceProfileCommand({
        InstanceProfileName: config.name,
        RoleName: roleName,
      }));
    }
    console.log(`[iam-instance-profile] ${config.name}: associating role ${config.roleName}`);
    await iam.send(new AddRoleToInstanceProfileCommand({
      InstanceProfileName: config.name,
      RoleName: config.roleName,
    }));
  }
  return (await describeInstanceProfile(ctx, config))!;
}

export async function destroyInstanceProfile(): Promise<never> {
  void DeleteInstanceProfileCommand;
  throw new Error(
    'forge refuses to destroy IAM instance profiles. EC2 launches that\n' +
    'reference the profile by name fail; ASG instance refresh stops.\n' +
    'Detach from launch templates first, then DeleteInstanceProfile.'
  );
}
