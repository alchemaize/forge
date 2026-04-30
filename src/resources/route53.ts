/**
 * Route 53 hosted zones + records resource module.
 *
 * Manages public and private hosted zones, plus their A/AAAA/CNAME/TXT/MX
 * records. Adoption-safe: extra records in AWS but not in config are left
 * alone. Destroy is refused (zones often hold records owned by humans
 * outside Forge's view; manual deletion is correct).
 *
 * Common pattern: zone + alias record pointing at a CloudFront distribution
 * or ALB. The alias structure carries dnsName + the target's hosted zone
 * ID (CloudFront is always Z2FDTNDATAQYW2; ALBs publish theirs in their
 * describe response).
 */

import {
  Route53Client,
  ListHostedZonesCommand,
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  type RRType,
  type ResourceRecordSet,
} from '@aws-sdk/client-route-53';
import type { AwsContext } from '../aws.js';
import type {
  Route53HostedZoneConfig,
  Route53RecordConfig,
} from '../config.js';
import { getClient, withContext, ForgeRefusedError } from '../aws.js';
import { addChange, type Plan } from '../diff.js';
export interface HostedZoneState {
  zoneId: string;
  name: string;
  privateZone: boolean;
  recordCount: number;
  nameServers: string[];
}

// Trailing-dot normalization: AWS stores zone names as `example.com.` but
// users tend to write `example.com`. Normalize on the way in.
function normalizeName(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeHostedZone(
  ctx: AwsContext,
  config: Route53HostedZoneConfig
): Promise<HostedZoneState | null> {
  const r53: Route53Client = getClient(ctx, Route53Client);
  const wantedName = normalizeName(config.name);
  const wantedPrivate = !!config.privateZone;

  // Paginate via Marker. AWS returns up to 100 zones per page; an account
  // with more than that would silently miss later zones, then `apply`
  // would call CreateHostedZone for an "absent" zone that already exists,
  // creating a duplicate with a different Id. Real risk for any account
  // running many domains.
  let match: { Id?: string; Name?: string; ResourceRecordSetCount?: number } | undefined;
  let marker: string | undefined;
  do {
    const list = await r53.send(new ListHostedZonesCommand({ Marker: marker }));
    match = (list.HostedZones ?? []).find(z =>
      z.Name === wantedName && (z.Config?.PrivateZone ?? false) === wantedPrivate
    );
    if (match) break;
    marker = list.IsTruncated ? list.NextMarker : undefined;
  } while (marker);

  if (!match) return null;

  // ID comes back as `/hostedzone/Z123ABC` from list; we want the bare ID.
  const zoneId = match.Id!.replace(/^\/hostedzone\//, '');

  const detail = await r53.send(new GetHostedZoneCommand({ Id: zoneId }));
  return {
    zoneId,
    name: match.Name!,
    privateZone: wantedPrivate,
    recordCount: match.ResourceRecordSetCount ?? 0,
    nameServers: detail.DelegationSet?.NameServers ?? [],
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planHostedZone(
  ctx: AwsContext,
  config: Route53HostedZoneConfig,
  _appName: string,
  plan: Plan
): Promise<HostedZoneState | null> {
  const current = await describeHostedZone(ctx, config);

  if (!current) {
    addChange(plan, {
      resourceType: 'route53-zone',
      resourceId: config.name,
      changeType: 'create',
      tier: 'config',
      fields: [
        { field: 'privateZone', current: undefined, desired: !!config.privateZone },
        { field: 'records', current: undefined, desired: config.records?.length ?? 0 },
      ],
    });
    return null;
  }

  // Compare desired vs live records. Only report missing — extras are
  // adoption-safe.
  const fields: Array<{ field: string; current: unknown; desired: unknown }> = [];
  if (config.records?.length) {
    const r53: Route53Client = getClient(ctx, Route53Client);
    const live = await fetchAllRecords(r53, current.zoneId);
    const missing = config.records.filter(r => !findLiveMatch(live, r, current.name));
    if (missing.length > 0) {
      fields.push({
        field: 'records',
        current: `${live.length} live`,
        desired: `+${missing.length} to add`,
      });
    }
  }

  addChange(plan, {
    resourceType: 'route53-zone',
    resourceId: config.name,
    changeType: fields.length > 0 ? 'update' : 'unchanged',
    tier: 'config',
    fields,
  });
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function fetchAllRecords(
  r53: Route53Client,
  zoneId: string
): Promise<ResourceRecordSet[]> {
  const all: ResourceRecordSet[] = [];
  let startName: string | undefined;
  let startType: RRType | undefined;
  while (true) {
    const res = await r53.send(new ListResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      StartRecordName: startName,
      StartRecordType: startType,
    }));
    all.push(...(res.ResourceRecordSets ?? []));
    if (!res.IsTruncated) break;
    startName = res.NextRecordName;
    startType = res.NextRecordType;
  }
  return all;
}

/**
 * Try to find a live record set matching the desired record. Match is by
 * (fully-qualified name, type). Apex records use the zone name; relative
 * records get the zone name suffix appended.
 */
function findLiveMatch(
  live: ResourceRecordSet[],
  desired: Route53RecordConfig,
  zoneName: string
): ResourceRecordSet | undefined {
  const fqdn = qualifyName(desired.name, zoneName);
  return live.find(r => r.Name === fqdn && r.Type === desired.type);
}

function qualifyName(name: string, zoneName: string): string {
  const trimmedZone = zoneName.replace(/\.$/, '');
  if (name === '@' || name === '' || name === trimmedZone || name === zoneName) {
    return zoneName;
  }
  if (name.endsWith('.')) return name;
  // Allow either fully-qualified `foo.example.com` or relative `foo`.
  if (name.endsWith(`.${trimmedZone}`)) return `${name}.`;
  return `${name}.${zoneName}`;
}

function buildRecordSet(
  desired: Route53RecordConfig,
  zoneName: string
): ResourceRecordSet {
  const Name = qualifyName(desired.name, zoneName);
  if (desired.alias) {
    return {
      Name,
      Type: desired.type as RRType,
      AliasTarget: {
        DNSName: desired.alias.dnsName,
        HostedZoneId: desired.alias.hostedZoneId,
        EvaluateTargetHealth: !!desired.alias.evaluateTargetHealth,
      },
    };
  }
  // TXT records have to be RFC-1035 quoted; do it for the user if they
  // didn't.
  const quoteIfTxt = (v: string) => {
    if (desired.type !== 'TXT') return v;
    return v.startsWith('"') && v.endsWith('"') ? v : `"${v}"`;
  };
  return {
    Name,
    Type: desired.type as RRType,
    TTL: desired.ttl ?? 300,
    ResourceRecords: (desired.values ?? []).map(v => ({ Value: quoteIfTxt(v) })),
  };
}

export async function applyHostedZone(
  ctx: AwsContext,
  config: Route53HostedZoneConfig,
  _appName: string
): Promise<HostedZoneState> {
  const r53: Route53Client = getClient(ctx, Route53Client);
  const wantedName = normalizeName(config.name);

  let current = await describeHostedZone(ctx, config);
  if (!current) {
    console.log(`[route53] Creating hosted zone: ${wantedName}`);
    try {
      const res = await r53.send(new CreateHostedZoneCommand({
        Name: wantedName,
        // CallerReference must be unique. Date.now() is fine since CreateHostedZone
        // is rarely called more than once per second per zone.
        CallerReference: `forge-${Date.now()}`,
        HostedZoneConfig: {
          Comment: config.comment,
          PrivateZone: !!config.privateZone,
        },
        VPC: config.privateZone && config.vpcs?.[0]
          ? { VPCId: config.vpcs[0].vpcId, VPCRegion: config.vpcs[0].vpcRegion as any }
          : undefined,
      }));
      const zoneId = res.HostedZone!.Id!.replace(/^\/hostedzone\//, '');
      const ns = res.DelegationSet?.NameServers ?? [];
      current = {
        zoneId,
        name: wantedName,
        privateZone: !!config.privateZone,
        recordCount: 2,  // SOA + NS
        nameServers: ns,
      };
      console.log(`[route53] Created: ${wantedName} (${zoneId})`);
      if (ns.length > 0 && !config.privateZone) {
        console.log(`[route53] Public zone — point your registrar at: ${ns.join(', ')}`);
      }
    } catch (err) {
      throw withContext(`[route53] CreateHostedZone ${wantedName}`, err);
    }
  }

  // Sync records: add missing.
  if (config.records?.length) {
    const live = await fetchAllRecords(r53, current.zoneId);
    const changes = config.records
      .filter(r => !findLiveMatch(live, r, current!.name))
      .map(r => ({
        Action: 'CREATE' as const,
        ResourceRecordSet: buildRecordSet(r, current!.name),
      }));
    if (changes.length > 0) {
      console.log(`[route53] ${current.name}: adding ${changes.length} record(s)`);
      try {
        await r53.send(new ChangeResourceRecordSetsCommand({
          HostedZoneId: current.zoneId,
          ChangeBatch: { Changes: changes },
        }));
      } catch (err) {
        throw withContext(`[route53] ChangeResourceRecordSets`, err);
      }
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyHostedZone(): Promise<never> {
  throw new ForgeRefusedError(
    'forge refuses to destroy Route 53 hosted zones. The zone often holds\n' +
    'records owned by humans outside Forge (manually-created MX, SPF, etc.)\n' +
    'and deletion would silently take them with it. Delete via AWS Console.'
  );
}
