/**
 * ACM (Certificate Manager) resource module.
 *
 * Requests public certificates and (optionally) auto-creates the DNS
 * validation records in a Route 53 hosted zone declared in the same
 * forge config. Adoption-safe: existing certs matching domain+SAN are
 * found and adopted; no new request is made.
 *
 * Validation flow:
 *   1. RequestCertificate with ValidationMethod='DNS'.
 *   2. AWS responds with a per-domain `_acmchallenge.<domain> CNAME ...`
 *      record that the user (or Forge, if validationZoneName is set)
 *      must add to DNS.
 *   3. AWS polls DNS; status moves PENDING_VALIDATION → ISSUED.
 *   4. Apply does NOT block on issuance (can take 5+ minutes); the user
 *      is told to re-run apply once the cert is validated, or
 *      Forge writes the records and lets AWS finish async.
 *
 * SAFETY: Compute-tier — destroy refused (other resources reference cert
 * ARNs; deletion breaks them).
 */

import {
  ACMClient,
  ListCertificatesCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
  type CertificateStatus,
  type ValidationMethod,
} from '@aws-sdk/client-acm';
import {
  Route53Client,
  ListHostedZonesCommand,
  ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import type { AwsContext } from '../aws.js';
import type { AcmCertificateConfig } from '../config.js';
import { getClient, withContext } from '../aws.js';
import { addChange, type Plan } from '../diff.js';

export interface AcmCertificateState {
  certificateArn: string;
  domainName: string;
  status: CertificateStatus | string;
  subjectAlternativeNames: string[];
  validationMethod: ValidationMethod | string;
  /** Pending DNS validation records — set when status is PENDING_VALIDATION. */
  validationRecords: Array<{ name: string; type: string; value: string; domain: string }>;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export async function describeAcm(
  ctx: AwsContext,
  config: AcmCertificateConfig
): Promise<AcmCertificateState | null> {
  const acm: ACMClient = getClient(ctx, ACMClient);

  // ListCertificates can be paginated; certificates are matched by domain
  // name AND SAN set so we don't accidentally adopt the wrong one.
  let nextToken: string | undefined;
  const wantedSans = new Set([config.domainName, ...(config.subjectAlternativeNames ?? [])].sort());
  while (true) {
    const list = await acm.send(new ListCertificatesCommand({
      NextToken: nextToken,
      MaxItems: 100,
    }));
    for (const summary of list.CertificateSummaryList ?? []) {
      if (summary.DomainName !== config.domainName) continue;
      const detail = await acm.send(new DescribeCertificateCommand({
        CertificateArn: summary.CertificateArn,
      }));
      const cert = detail.Certificate!;
      const liveSans = new Set((cert.SubjectAlternativeNames ?? []).slice().sort());
      const sansMatch =
        liveSans.size === wantedSans.size &&
        [...wantedSans].every(s => liveSans.has(s));
      if (!sansMatch) continue;

      return {
        certificateArn: cert.CertificateArn!,
        domainName: cert.DomainName!,
        status: cert.Status ?? 'PENDING_VALIDATION',
        subjectAlternativeNames: cert.SubjectAlternativeNames ?? [],
        validationMethod: cert.DomainValidationOptions?.[0]?.ValidationMethod ?? 'DNS',
        validationRecords: (cert.DomainValidationOptions ?? [])
          .filter(opt => opt.ResourceRecord)
          .map(opt => ({
            domain: opt.DomainName!,
            name: opt.ResourceRecord!.Name!,
            type: opt.ResourceRecord!.Type!,
            value: opt.ResourceRecord!.Value!,
          })),
      };
    }
    if (!list.NextToken) break;
    nextToken = list.NextToken;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planAcm(
  ctx: AwsContext,
  config: AcmCertificateConfig,
  _appName: string,
  plan: Plan
): Promise<AcmCertificateState | null> {
  const current = await describeAcm(ctx, config);

  if (!current) {
    addChange(plan, {
      resourceType: 'acm-certificate',
      resourceId: config.name,
      changeType: 'create',
      tier: 'compute',
      fields: [
        { field: 'domainName', current: undefined, desired: config.domainName },
        { field: 'sans', current: undefined, desired: config.subjectAlternativeNames?.length ?? 0 },
        { field: 'validation', current: undefined, desired: config.validation ?? 'DNS' },
      ],
    });
    return null;
  }

  // Existing cert: surface PENDING_VALIDATION as a real status (the user
  // needs to add DNS records and wait, even though Forge isn't going to
  // mutate AWS state on this run).
  if (current.status === 'PENDING_VALIDATION') {
    addChange(plan, {
      resourceType: 'acm-certificate',
      resourceId: config.name,
      changeType: 'update',
      tier: 'compute',
      fields: [{
        field: 'status',
        current: 'PENDING_VALIDATION',
        desired: 'ISSUED (waiting on DNS)',
      }],
    });
  } else {
    addChange(plan, {
      resourceType: 'acm-certificate',
      resourceId: config.name,
      changeType: 'unchanged',
      tier: 'compute',
      fields: [],
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Write the ACM-issued DNS validation records into a Route 53 zone.
 * Returns true when records were written (so the user knows AWS will
 * begin validation).
 */
async function writeValidationToRoute53(
  ctx: AwsContext,
  zoneName: string,
  records: AcmCertificateState['validationRecords']
): Promise<boolean> {
  const r53: Route53Client = getClient(ctx, Route53Client);
  const zoneNameNorm = zoneName.endsWith('.') ? zoneName : `${zoneName}.`;
  const zones = await r53.send(new ListHostedZonesCommand({}));
  const zone = (zones.HostedZones ?? []).find(z => z.Name === zoneNameNorm);
  if (!zone) {
    console.log(`[acm] validationZoneName '${zoneName}' not found in Route 53 — skipping auto-create. Add the records manually:`);
    for (const r of records) console.log(`         ${r.name}  ${r.type}  ${r.value}`);
    return false;
  }
  const zoneId = zone.Id!.replace(/^\/hostedzone\//, '');

  // ACM uses one CNAME per domain validation. Use UPSERT so re-runs are
  // idempotent (writing the same value over the existing record is fine).
  const changes = records.map(r => ({
    Action: 'UPSERT' as const,
    ResourceRecordSet: {
      Name: r.name,
      Type: r.type as 'CNAME',
      TTL: 60,
      ResourceRecords: [{ Value: r.value }],
    },
  }));
  if (changes.length === 0) return false;

  console.log(`[acm] Writing ${changes.length} validation record(s) to ${zoneName}`);
  try {
    await r53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: { Changes: changes },
    }));
  } catch (err) {
    throw withContext(`[acm] ChangeResourceRecordSets validation`, err);
  }
  return true;
}

export async function applyAcm(
  ctx: AwsContext,
  config: AcmCertificateConfig,
  _appName: string
): Promise<AcmCertificateState> {
  const acm: ACMClient = getClient(ctx, ACMClient);
  let current = await describeAcm(ctx, config);

  if (!current) {
    const validationMethod = (config.validation ?? 'DNS') as ValidationMethod;
    console.log(`[acm] Requesting certificate: ${config.domainName}${config.subjectAlternativeNames?.length ? ` (+${config.subjectAlternativeNames.length} SANs)` : ''}`);
    try {
      const res = await acm.send(new RequestCertificateCommand({
        DomainName: config.domainName,
        SubjectAlternativeNames: config.subjectAlternativeNames,
        ValidationMethod: validationMethod,
        Options: config.transparencyLogging === false
          ? { CertificateTransparencyLoggingPreference: 'DISABLED' }
          : undefined,
      }));
      console.log(`[acm] Requested: ${res.CertificateArn}`);
      // ACM populates DomainValidationOptions a few seconds after request.
      // Re-describe with brief retry to surface the DNS records the user
      // needs to add.
      for (let i = 0; i < 10 && !current; i++) {
        await new Promise(r => setTimeout(r, 1500));
        current = await describeAcm(ctx, config);
      }
    } catch (err) {
      throw withContext(`[acm] RequestCertificate ${config.domainName}`, err);
    }
  } else {
    console.log(`[acm] Certificate exists: ${config.domainName} (${current.status})`);
  }

  if (!current) {
    throw new Error(`[acm] ${config.domainName}: requested but not yet visible in describe. Re-run apply.`);
  }

  // Validation auto-write: only if config asks for it, the cert has
  // pending validation records, and the cert isn't already issued.
  if (
    config.validationZoneName &&
    current.status === 'PENDING_VALIDATION' &&
    current.validationRecords.length > 0
  ) {
    const wrote = await writeValidationToRoute53(ctx, config.validationZoneName, current.validationRecords);
    if (wrote) {
      console.log(`[acm] Validation records written. AWS will issue the cert within ~5 minutes; re-run plan/apply to confirm.`);
    }
  } else if (current.status === 'PENDING_VALIDATION' && !config.validationZoneName) {
    console.log(`[acm] ${config.domainName}: PENDING_VALIDATION. Add these CNAME(s) at your DNS provider:`);
    for (const r of current.validationRecords) {
      console.log(`         ${r.name}  ${r.type}  ${r.value}`);
    }
    console.log(`[acm] Or set validationZoneName in config to have Forge write them into a Route 53 zone in the same config.`);
  }

  return current;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyAcm(_ctx: AwsContext, name: string): Promise<never> {
  throw new Error(
    `forge refuses to destroy ACM certificate '${name}'. CloudFront / ALB /\n` +
    'API Gateway resources reference cert ARNs and break immediately if the\n' +
    'cert is deleted. Disassociate from every consumer, wait for propagation,\n' +
    'then DeleteCertificate via AWS Console or CLI.'
  );
}
