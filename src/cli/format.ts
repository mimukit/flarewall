// The CLI text: the line formatters and outcome text that the CLI and the TUI both print.
import type { ApplyResult, RestorePlan, RestoreResult, RuleStep, ZonePlan } from '../core/apply.js';
import { changeValues, type Change, type ForeignRule } from '../core/diff.js';
import type { ZoneReport } from '../core/status.js';

/** Pads each column but the last to its widest cell and joins the cells with two spaces. */
export function columns(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ').trimEnd());
}

/** The `status` table: one row per zone with its name, plan, and state. */
export function statusLines(reports: readonly ZoneReport[]): string[] {
  const rows = [['ZONE', 'PLAN', 'STATE']];
  for (const r of reports) rows.push([r.zone, r.plan || '-', r.state === 'error' ? `error: ${r.error ?? ''}` : r.state]);
  return columns(rows);
}

/** A setting or Bot Fight Mode value as JSON, or `(none)` when it is absent. */
export function show(value: unknown): string {
  return value === undefined ? '(none)' : JSON.stringify(value);
}

/** One diff change as a line. */
export function changeLine(c: Change): string {
  switch (c.kind) {
    case 'missing':
      return `${c.phase}: missing ${c.ref} "${c.description}"`;
    case 'extra':
      return `${c.phase}: extra ${c.ref} "${c.description}"`;
    case 'changed':
      return `${c.phase}: changed ${c.ref} "${c.description}" (${c.fields.join(', ')})`;
    case 'order':
      return `${c.phase}: order is ${c.actual.join(', ')}; want ${c.expected.join(', ')}`;
    case 'setting':
      return `setting ${c.setting}: live ${show(c.actual)}; want ${show(c.expected)}`;
    case 'bot_management':
      return `bot management: live ${show(c.actual)}; want ${show(c.expected)}`;
  }
}

/** One legacy or unowned rule as a line; `kind` names which. */
export function foreignLine(kind: string, r: ForeignRule): string {
  const name = [r.ref, r.description === undefined ? undefined : `"${r.description}"`].filter(Boolean).join(' ') || '(no ref or description)';
  return `${r.phase}: ${kind} ${name}${r.id ? ` (id ${r.id})` : ''}`;
}

/** One line of a zone's diff, with the section it sits in: a phase, `settings`, or `bot management`. */
export interface DiffLine {
  text: string;
  /** Absent on the zone line. */
  section?: string;
}

export interface DiffLineOptions {
  /** Show the legacy and unowned rules. Default true. */
  foreign?: boolean;
  /** Show the live and wanted value of each changed rule field. Default false. */
  values?: boolean;
}

function changeSection(c: Change): string {
  if (c.kind === 'setting') return 'settings';
  if (c.kind === 'bot_management') return 'bot management';
  return c.phase;
}

/** One zone's `diff` output: its state, then its legacy rules, changes, and unowned rules. */
export function zoneDiffLines(r: ZoneReport, options: DiffLineOptions = {}): DiffLine[] {
  if (r.state === 'error') return [{ text: `${r.zone}: error: ${r.error ?? ''}` }];
  if (r.state === 'not managed') return [{ text: `${r.zone}: not managed (no inventory entry; run flarewall add ${r.zone})` }];
  const lines: DiffLine[] = [{ text: `${r.zone}: ${r.state}` }];
  const diff = r.diff;
  if (diff === undefined) return lines;
  const foreign = options.foreign ?? true;
  if (foreign) for (const l of diff.legacy) lines.push({ text: `  ${foreignLine('legacy', l)}`, section: l.phase });
  for (const c of diff.changes) {
    lines.push({ text: `  ${changeLine(c)}`, section: changeSection(c) });
    if (options.values === true && c.kind === 'changed' && r.detail !== undefined) {
      for (const v of changeValues(r.detail.desired, r.detail.live, c)) {
        lines.push({ text: `    ${v.field}: live ${show(v.live)}; want ${show(v.want)}`, section: c.phase });
      }
    }
  }
  if (foreign) for (const u of diff.unowned) lines.push({ text: `  ${foreignLine('unowned', u)}`, section: u.phase });
  return lines;
}

/** The `diff` output: each zone state, then its legacy rules, changes, and unowned rules. */
export function diffLines(reports: readonly ZoneReport[]): string[] {
  return reports.flatMap((r) => zoneDiffLines(r).map((l) => l.text));
}

/** One planned rule step as a line. */
export function stepLine(s: RuleStep): string {
  const id = s.id ? ` (id ${s.id})` : '';
  switch (s.kind) {
    case 'create':
      return `create ${s.ref}`;
    case 'update':
      return `update ${s.ref}${id}`;
    case 'replace':
      return `replace legacy "${s.legacy}"${id} with ${s.ref}`;
    case 'keep':
      return `keep unowned ${[s.ref, s.description === undefined ? undefined : `"${s.description}"`].filter(Boolean).join(' ')}${id}`;
    case 'remove':
      return `remove ${[s.ref, s.description === undefined ? undefined : `"${s.description}"`].filter(Boolean).join(' ')}${id}`;
  }
}

/** The apply plan for one zone; empty when the zone has nothing to send and no limit error. */
export function planLines(plan: ZonePlan): string[] {
  if (!plan.hasWrites && plan.limitErrors.length === 0) return [];
  const lines = [`${plan.zone}: plan`];
  for (const p of plan.phases) {
    if (!p.write) {
      lines.push(`  ${p.phase}: no change`);
      continue;
    }
    lines.push(`  ${p.phase}: send ${p.rules.length} rules (${p.owned} owned, ${p.unowned} unowned)`);
    for (const s of p.steps) lines.push(`    ${stepLine(s)}`);
  }
  for (const s of plan.settings) lines.push(`  setting ${s.id}: ${show(s.live)} -> ${show(s.want)}`);
  if (plan.botManagement !== undefined) lines.push(`  bot management: ${show(plan.botManagement.live)} -> ${show(plan.botManagement.want)}`);
  return lines;
}

/** The restore plan for one zone from the backup directory `dir`. */
export function restoreLines(plan: RestorePlan, dir: string): string[] {
  const lines = [`${plan.zone}: restore from ${dir}`];
  for (const p of plan.phases) {
    lines.push(`  ${p.phase}: send ${p.rules.length} rules`);
    for (const r of p.rules) {
      const name = [r.ref, r.description === undefined ? undefined : `"${r.description}"`].filter(Boolean).join(' ') || '(no ref or description)';
      lines.push(`    ${name}${r.id ? ` (id ${r.id})` : ''}`);
    }
  }
  for (const s of plan.settings) lines.push(`  setting ${s.id}: send ${show(s.value)}`);
  if (plan.botManagement !== undefined) lines.push(`  bot management: send ${show(plan.botManagement)}`);
  return lines;
}

const APPLY_OUTCOME_TEXT: Readonly<Record<ApplyResult['outcome'], string>> = {
  'no change': 'in sync, nothing to send',
  'dry run': 'dry run, nothing sent; pass --write to send',
  declined: 'declined, nothing sent',
  applied: 'applied, read-back in sync',
};

/** The text for one apply outcome, as printed after the zone name. */
export function applyOutcomeText(outcome: ApplyResult['outcome']): string {
  return APPLY_OUTCOME_TEXT[outcome];
}

const RESTORE_OUTCOME_TEXT: Readonly<Record<RestoreResult['outcome'], string>> = {
  'dry run': 'dry run, nothing sent; pass --write to send',
  declined: 'declined, nothing sent',
  restored: 'restored, read-back matches the backup',
};

/** The text for one restore outcome, as printed after the zone name. */
export function restoreOutcomeText(outcome: RestoreResult['outcome']): string {
  return RESTORE_OUTCOME_TEXT[outcome];
}
