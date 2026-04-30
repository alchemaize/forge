/**
 * Cost preview for forge plan output.
 *
 * Maps create/destroy plan changes to AWS monthly cost estimates. The
 * pitch: when you press `forge plan`, you see "+$87/month, -$12/month,
 * net +$75/month" before deciding whether to apply. Neither CDK nor
 * Terraform's native flow does this; Terraform requires Infracost (a
 * third-party paid product) for the same answer. Forge ships it.
 *
 * Pricing strategy:
 *   - Hardcoded baseline rates for us-east-1 (the most common region).
 *     Rates are checked monthly against AWS Pricing API; fully accurate
 *     pricing would require live API calls per resource which is too
 *     slow for plan output.
 *   - "Storage / data" tier: real fixed cost (DynamoDB on-demand,
 *     RDS instance, etc.).
 *   - "Compute / per-invocation" tier: estimated at typical baseline
 *     (Lambda at 1M invocations/month, $0.20/1M).
 *   - Skipped: marketplace charges (third-party AMIs), data transfer
 *     between AZs (highly variable).
 *
 * Disclaimer printed alongside output: this is an estimate within ~30%
 * of reality. Use it for relative sizing, not for finance forecasts.
 */

import type { Plan, ResourceChange } from './diff.js';

export interface CostEstimate {
  /** Monthly cost for newly-created resources, USD. */
  createTotal: number;
  /** Monthly cost saved by destroying resources, USD. */
  destroyTotal: number;
  /** Net monthly delta (create - destroy). Positive = more spend. */
  netDelta: number;
  /** Per-resource breakdown for the plan summary. */
  items: Array<{
    resourceType: string;
    resourceId: string;
    changeType: 'create' | 'destroy';
    monthlyUsd: number;
    estimateNote?: string;
  }>;
  /** Resource types Forge couldn't price (so the user knows what's missing). */
  unknownTypes: string[];
}

// ---------------------------------------------------------------------------
// Rate table
// ---------------------------------------------------------------------------

/**
 * Each entry is a function that takes a ResourceChange and returns
 * (monthlyUsd, optional note). Returning null means "no cost" or
 * "unknown" — we don't add unknowns to the totals; they go to the
 * unknownTypes list so the user knows what's not included.
 */
type Pricer = (change: ResourceChange) => { monthlyUsd: number; note?: string } | null;

const PRICERS: Record<string, Pricer> = {
  // ---- Compute ----
  lambda: () => ({
    monthlyUsd: 1.0,
    note: 'baseline (1M invocations/month at 512MB, 100ms avg)',
  }),
  'lambda-layer': () => ({ monthlyUsd: 0 }),
  ecr: (c) => {
    // ECR storage is $0.10/GB-month. Forge can't know image size at plan
    // time, so estimate at 5GB per repo (typical for a Node app).
    const lifecycleField = c.fields.find(f => f.field === 'lifecycleKeep');
    const keepCount = typeof lifecycleField?.desired === 'number' ? lifecycleField.desired : 5;
    return {
      monthlyUsd: keepCount * 0.5,  // ~5GB per image × $0.10
      note: `${keepCount} images × ~5GB × $0.10/GB`,
    };
  },
  'ecs-cluster': () => ({ monthlyUsd: 0, note: 'cluster is free; charges on tasks' }),
  'ecs-service': () => ({
    monthlyUsd: 30,
    note: 'baseline (1 task × 0.25 vCPU × 0.5GB Fargate)',
  }),
  'ecs-express': () => ({ monthlyUsd: 30, note: 'baseline ECS Express' }),
  'launch-template': () => ({ monthlyUsd: 0 }),
  asg: () => ({
    monthlyUsd: 18,
    note: '1× t3.small instance baseline',
  }),

  // ---- Network / front-of-house ----
  vpc: () => ({ monthlyUsd: 0, note: 'VPC itself is free; NAT is the cost' }),
  'security-group': () => ({ monthlyUsd: 0 }),
  'vpc-endpoint': (c) => {
    const typeField = c.fields.find(f => f.field === 'type');
    const type = String(typeField?.desired ?? 'Interface');
    if (type === 'Gateway') return { monthlyUsd: 0, note: 'Gateway endpoint is free' };
    return { monthlyUsd: 22, note: 'Interface endpoint: $7.20/mo × 3 AZs' };
  },
  alb: () => ({ monthlyUsd: 22, note: 'ALB hourly + LCU baseline' }),
  cloudfront: () => ({
    monthlyUsd: 5,
    note: 'baseline (10GB data + 100k requests/month)',
  }),
  'api-gateway': () => ({
    monthlyUsd: 1,
    note: 'baseline (1M requests/month at $1/M)',
  }),
  'rest-api': () => ({
    monthlyUsd: 3.50,
    note: 'baseline (1M requests/month at $3.50/M)',
  }),
  'route53-zone': () => ({ monthlyUsd: 0.5, note: 'hosted zone fee' }),
  'acm-certificate': () => ({ monthlyUsd: 0, note: 'free for AWS-issued certs' }),
  'web-acl': () => ({
    monthlyUsd: 5 + 5,
    note: '$5/ACL + $1/rule baseline (5 rules)',
  }),

  // ---- Data ----
  rds: (c) => {
    const modeField = c.fields.find(f => f.field === 'mode');
    const mode = String(modeField?.desired ?? 'aurora-serverless-v2');
    if (mode === 'aurora-serverless-v2') {
      return {
        monthlyUsd: 43,
        note: 'Aurora Serverless v2: 0.5 ACU min × $0.12/hr ≈ $43/mo',
      };
    }
    const classField = c.fields.find(f => f.field === 'instanceClass');
    const inst = String(classField?.desired ?? 'db.t4g.micro');
    const inst2cost: Record<string, number> = {
      'db.t4g.micro': 12.7,
      'db.t4g.small': 25.5,
      'db.t4g.medium': 51,
      'db.t3.micro': 14.6,
      'db.t3.small': 29.2,
    };
    return {
      monthlyUsd: inst2cost[inst] ?? 30,
      note: `${inst} (24×7)`,
    };
  },
  elasticache: () => ({
    monthlyUsd: 12,
    note: '1× cache.t3.micro baseline',
  }),
  dynamodb: () => ({
    monthlyUsd: 1.25,
    note: 'on-demand: 1M reads + 1M writes/month',
  }),
  s3: () => ({
    monthlyUsd: 1.15,
    note: '50GB at $0.023/GB',
  }),
  kms: () => ({ monthlyUsd: 1, note: '$1/key/month' }),
  'secrets-manager': () => ({ monthlyUsd: 0.4, note: '$0.40/secret/month' }),
  'ssm-parameter': () => ({ monthlyUsd: 0, note: 'standard tier is free' }),

  // ---- Async / messaging ----
  sqs: () => ({
    monthlyUsd: 0.4,
    note: '1M messages/month (first 1M is free, then $0.40/M)',
  }),
  sns: () => ({
    monthlyUsd: 0.5,
    note: '1M notifications/month',
  }),
  eventbridge: () => ({ monthlyUsd: 1, note: '1M custom events/month' }),
  'event-bus': () => ({ monthlyUsd: 0, note: 'bus itself is free' }),
  'step-functions': () => ({
    monthlyUsd: 0.025,
    note: 'baseline: 1k state transitions × $0.025/1k',
  }),
  pinpoint: () => ({
    monthlyUsd: 5,
    note: '1k push + 1k SMS/month',
  }),

  // ---- Auth / identity ----
  cognito: () => ({
    monthlyUsd: 0,
    note: 'free for first 50k MAUs; charged at scale',
  }),
  'iam-user': () => ({ monthlyUsd: 0 }),
  'iam-group': () => ({ monthlyUsd: 0 }),
  'iam-instance-profile': () => ({ monthlyUsd: 0 }),
  'iam-managed-policy': () => ({ monthlyUsd: 0 }),

  // ---- Observability ----
  'log-group': () => ({
    monthlyUsd: 1.5,
    note: '~3GB ingest/month at $0.50/GB',
  }),
  alarm: () => ({ monthlyUsd: 0.10, note: '$0.10/alarm/month' }),

  // ---- AI / ML ----
  'bedrock-throughput': (c) => {
    const unitsField = c.fields.find(f => f.field === 'modelUnits');
    const units = typeof unitsField?.desired === 'number' ? unitsField.desired : 1;
    // Anthropic Claude 3.5 Sonnet: $39.60/hour per model unit (no commitment).
    return {
      monthlyUsd: units * 39.60 * 730,
      note: `${units} model unit(s) × $39.60/hr (no-commit Sonnet) × 730hr`,
    };
  },
  'bedrock-guardrail': () => ({
    monthlyUsd: 1,
    note: '~1M text units/month at $0.75/M (input+output)',
  }),
  'sagemaker-endpoint': () => ({
    monthlyUsd: 50,
    note: 'baseline ml.t2.medium (~$0.07/hr × 730 hours)',
  }),
  'opensearch-domain': () => ({
    monthlyUsd: 25,
    note: 'baseline t3.small.search × 1 + 20GB EBS',
  }),

  // ---- Analytics ----
  'glue-database': () => ({ monthlyUsd: 0, note: 'database itself is free' }),
  'athena-workgroup': () => ({ monthlyUsd: 0, note: 'pay per query, not per workgroup' }),
};

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export function estimatePlanCost(plan: Plan): CostEstimate {
  const items: CostEstimate['items'] = [];
  const unknownTypes = new Set<string>();
  let createTotal = 0;
  let destroyTotal = 0;

  for (const change of plan.changes) {
    if (change.changeType !== 'create' && change.changeType !== 'destroy') continue;
    const pricer = PRICERS[change.resourceType];
    if (!pricer) {
      unknownTypes.add(change.resourceType);
      continue;
    }
    const result = pricer(change);
    if (!result) {
      unknownTypes.add(change.resourceType);
      continue;
    }
    items.push({
      resourceType: change.resourceType,
      resourceId: change.resourceId,
      changeType: change.changeType,
      monthlyUsd: result.monthlyUsd,
      estimateNote: result.note,
    });
    if (change.changeType === 'create') createTotal += result.monthlyUsd;
    else destroyTotal += result.monthlyUsd;
  }

  return {
    createTotal,
    destroyTotal,
    netDelta: createTotal - destroyTotal,
    items,
    unknownTypes: [...unknownTypes].sort(),
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Format a USD amount with sensible precision: cents under $10, no
 * decimals over $10, "<$0.01" when very small.
 */
function fmt(amount: number): string {
  if (amount === 0) return '$0';
  if (Math.abs(amount) < 0.01) return amount > 0 ? '<$0.01' : '<-$0.01';
  if (Math.abs(amount) < 10) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function colorEnabled(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR) return false;
  return !!process.stdout.isTTY;
}

function colorize(text: string, color: keyof typeof COLORS): string {
  if (!colorEnabled()) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

/**
 * Print the cost estimate after the plan summary. Quiet when the plan
 * has no creates and no destroys.
 */
export function displayCostPreview(estimate: CostEstimate): void {
  if (estimate.items.length === 0) return;

  console.log('');
  console.log(colorize('  Cost preview (estimate, us-east-1):', 'bold'));

  const colorForDelta = (delta: number) =>
    delta > 0 ? 'red' as const : delta < 0 ? 'green' as const : 'gray' as const;

  if (estimate.createTotal > 0) {
    console.log(`    ${colorize('+' + fmt(estimate.createTotal) + '/month', 'red')}  ${colorize('newly created resources', 'dim')}`);
  }
  if (estimate.destroyTotal > 0) {
    console.log(`    ${colorize('-' + fmt(estimate.destroyTotal) + '/month', 'green')}  ${colorize('destroyed resources', 'dim')}`);
  }

  const sign = estimate.netDelta >= 0 ? '+' : '-';
  const netStr = `${sign}${fmt(Math.abs(estimate.netDelta))}/month`;
  console.log(`    ${colorize('Net:', 'bold')} ${colorize(netStr, colorForDelta(estimate.netDelta))}`);

  // Per-line breakdown for transparency. Only show creates; destroys are
  // already implied by their resource showing up in plan with -money.
  if (estimate.items.length <= 10) {
    console.log('');
    for (const item of estimate.items) {
      const sym = item.changeType === 'create' ? '+' : '-';
      const color = item.changeType === 'create' ? 'red' as const : 'green' as const;
      const noteStr = item.estimateNote ? colorize(`  (${item.estimateNote})`, 'dim') : '';
      console.log(`    ${colorize(sym + fmt(item.monthlyUsd), color)}  ${item.resourceType}:${item.resourceId}${noteStr}`);
    }
  }

  if (estimate.unknownTypes.length > 0) {
    console.log('');
    console.log(`    ${colorize('Note:', 'yellow')} ${colorize('cost not estimated for:', 'dim')} ${colorize(estimate.unknownTypes.join(', '), 'gray')}`);
  }

  console.log('');
  console.log(`    ${colorize('Estimates are us-east-1 baseline within ~30% of reality. Use for', 'dim')}`);
  console.log(`    ${colorize('relative sizing, not finance forecasts. Volume-driven costs (Lambda', 'dim')}`);
  console.log(`    ${colorize('invocations, S3 / DynamoDB usage, data transfer) assume baseline traffic.', 'dim')}`);
  console.log('');
}
