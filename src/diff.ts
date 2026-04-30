/**
 * Diff computation and display.
 * Shows what forge will do before doing it.
 */

/**
 * Plan-level change classifications.
 *
 * `destroy` is reserved but not currently emitted by `forge plan` runs.
 * The `forge destroy` CLI subcommand operates outside the plan flow; it
 * runs a single named resource through its module's destroy function
 * rather than producing a plan + apply cycle. The destroy variant exists
 * here so a future "orphan detection" mode can flag resources present in
 * AWS but absent from the config without changing the plan-output schema.
 */
export type ChangeType = 'create' | 'update' | 'unchanged' | 'destroy';

export interface FieldChange {
  field: string;
  current: unknown;
  desired: unknown;
}

export interface ResourceChange {
  resourceType: string;
  resourceId: string;
  changeType: ChangeType;
  tier: 'data' | 'compute' | 'config';
  fields: FieldChange[];
}

export interface Plan {
  changes: ResourceChange[];
  hasChanges: boolean;
  summary: { create: number; update: number; unchanged: number; destroy: number };
}

export function createPlan(): Plan {
  return {
    changes: [],
    hasChanges: false,
    summary: { create: 0, update: 0, unchanged: 0, destroy: 0 },
  };
}

export function addChange(plan: Plan, change: ResourceChange): void {
  plan.changes.push(change);
  plan.summary[change.changeType]++;
  if (change.changeType !== 'unchanged') {
    plan.hasChanges = true;
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/**
 * Color is on for interactive terminals, off when piped to a file or
 * when NO_COLOR is set. Honors the NO_COLOR convention (https://no-color.org/)
 * and FORCE_COLOR for the rare case of wanting color despite a non-TTY.
 */
function colorEnabled(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR) return false;
  return !!process.stdout.isTTY;
}

function colorize(text: string, color: keyof typeof COLORS): string {
  if (!colorEnabled()) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function changeSymbol(type: ChangeType): string {
  switch (type) {
    case 'create': return colorize('+', 'green');
    case 'update': return colorize('~', 'yellow');
    case 'destroy': return colorize('-', 'red');
    case 'unchanged': return colorize('=', 'gray');
  }
}

function changeLabel(type: ChangeType): string {
  switch (type) {
    case 'create': return colorize('CREATE', 'green');
    case 'update': return colorize('UPDATE', 'yellow');
    case 'destroy': return colorize('DESTROY', 'red');
    case 'unchanged': return colorize('unchanged', 'gray');
  }
}

function formatValue(val: unknown): string {
  if (val === undefined || val === null) return colorize('(none)', 'dim');
  if (typeof val === 'string') return `"${val}"`;
  if (typeof val === 'object') return JSON.stringify(val, null, 2);
  return String(val);
}

export function displayPlan(plan: Plan): void {
  console.log('');
  console.log(colorize('═══ Forge Plan ═══', 'bold'));
  console.log('');

  if (!plan.hasChanges) {
    console.log(colorize('  No changes. Infrastructure matches config.', 'green'));
    console.log('');
    return;
  }

  for (const change of plan.changes) {
    if (change.changeType === 'unchanged') continue;

    const symbol = changeSymbol(change.changeType);
    const label = changeLabel(change.changeType);
    const tierBadge = change.tier === 'data'
      ? colorize('[DATA]', 'red')
      : change.tier === 'compute'
        ? colorize('[COMPUTE]', 'yellow')
        : colorize('[CONFIG]', 'gray');

    console.log(`  ${symbol} ${label} ${tierBadge} ${colorize(change.resourceType, 'cyan')}:${colorize(change.resourceId, 'bold')}`);

    for (const field of change.fields) {
      if (change.changeType === 'create') {
        console.log(`      ${colorize(field.field, 'dim')}: ${colorize(formatValue(field.desired), 'green')}`);
      } else if (change.changeType === 'update') {
        console.log(`      ${colorize(field.field, 'dim')}: ${formatValue(field.current)} → ${colorize(formatValue(field.desired), 'yellow')}`);
      }
    }
    console.log('');
  }

  // Summary
  const parts: string[] = [];
  if (plan.summary.create > 0) parts.push(colorize(`${plan.summary.create} to create`, 'green'));
  if (plan.summary.update > 0) parts.push(colorize(`${plan.summary.update} to update`, 'yellow'));
  if (plan.summary.destroy > 0) parts.push(colorize(`${plan.summary.destroy} to destroy`, 'red'));
  if (plan.summary.unchanged > 0) parts.push(colorize(`${plan.summary.unchanged} unchanged`, 'gray'));

  console.log(`  ${colorize('Summary:', 'bold')} ${parts.join(', ')}`);
  console.log('');
}
