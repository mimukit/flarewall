// diffZone: compares a zone's desired state with its live state on an allowlist of fields.
// Core module: no Node-only API here, so a Worker can run it.
import type { BotManagementState, LiveRule, SettingId } from './api.js';
import { isLegacyRule } from './legacy.js';
import { PHASES, type DesiredZone, type Phase, type Rule } from './render.js';

export const OWNED_PREFIX = 'flarewall_';

/** Every state a zone can show. diffZone returns only the last three. */
export type ZoneState = 'error' | 'not managed' | 'legacy' | 'drift' | 'in sync';

/** The live state flarewall reads for one zone: only the parts the desired state manages. */
export interface LiveZone {
  phases: Partial<Record<Phase, LiveRule[]>>;
  settings: Partial<Record<SettingId, unknown>>;
  botManagement?: BotManagementState;
}

/** The fields compared on an owned rule, in report order. */
export const COMPARED_FIELDS = ['description', 'action', 'expression', 'enabled', 'action_parameters', 'ratelimit'] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

export type Change =
  | { kind: 'missing'; phase: Phase; ref: string; description: string }
  | { kind: 'extra'; phase: Phase; ref: string; description: string; id?: string }
  | { kind: 'changed'; phase: Phase; ref: string; description: string; fields: ComparedField[] }
  | { kind: 'order'; phase: Phase; expected: string[]; actual: string[] }
  | { kind: 'setting'; setting: SettingId; expected: unknown; actual: unknown }
  | { kind: 'bot_management'; expected: BotManagementState; actual: BotManagementState | undefined };

/** A live rule flarewall does not own, kept apart from the changes. */
export interface ForeignRule {
  phase: Phase;
  id?: string;
  ref?: string;
  description?: string;
}

export interface ZoneDiff {
  state: 'legacy' | 'drift' | 'in sync';
  changes: Change[];
  /** Rules with no flarewall_ ref that the old script did not write. Never drift. */
  unowned: ForeignRule[];
  /** Rules the old script wrote. Any one of them makes the zone `legacy`. */
  legacy: ForeignRule[];
}

export function isOwnedRule(rule: { ref?: unknown }): boolean {
  return typeof rule.ref === 'string' && rule.ref.startsWith(OWNED_PREFIX);
}

/** Sorts object keys at every level, so key order never counts as a change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The ratelimit fields compared, as the old script's read-back does. The API adds others on read. */
export const COMPARED_RATELIMIT_FIELDS = ['characteristics', 'period', 'requests_per_period', 'mitigation_timeout'] as const;

/** The compared part of a ratelimit object: the fields above only, characteristics sorted. */
export function comparedRatelimit(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const ratelimit = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of COMPARED_RATELIMIT_FIELDS) {
    const v = ratelimit[field];
    if (v === undefined) continue;
    out[field] = field === 'characteristics' && Array.isArray(v) ? [...(v as unknown[])].map(String).sort() : v;
  }
  return out;
}

/** The compared value of one field: enabled defaults to true, ratelimit is narrowed. */
export function fieldValue(rule: Rule | LiveRule, field: ComparedField): unknown {
  const value = rule[field];
  if (field === 'enabled') return value ?? true;
  if (field === 'ratelimit') return comparedRatelimit(value);
  return value;
}

function foreign(phase: Phase, rule: LiveRule): ForeignRule {
  const out: ForeignRule = { phase };
  if (typeof rule.id === 'string') out.id = rule.id;
  if (typeof rule.ref === 'string') out.ref = rule.ref;
  if (typeof rule.description === 'string') out.description = rule.description;
  return out;
}

function diffPhase(phase: Phase, desired: Rule[], live: LiveRule[], diff: ZoneDiff): void {
  const liveOwned = new Map<string, LiveRule>();
  const liveOrder: string[] = [];
  for (const rule of live) {
    if (isLegacyRule(rule)) {
      diff.legacy.push(foreign(phase, rule));
    } else if (!isOwnedRule(rule)) {
      diff.unowned.push(foreign(phase, rule));
    } else if (liveOwned.has(rule.ref as string) || !desired.some((d) => d.ref === rule.ref)) {
      // A duplicate, or an owned rule the baseline no longer renders for this zone.
      diff.changes.push({ kind: 'extra', phase, ref: rule.ref as string, description: rule.description ?? '', ...(rule.id ? { id: rule.id } : {}) });
    } else {
      liveOwned.set(rule.ref as string, rule);
      liveOrder.push(rule.ref as string);
    }
  }

  for (const want of desired) {
    const have = liveOwned.get(want.ref);
    if (have === undefined) {
      diff.changes.push({ kind: 'missing', phase, ref: want.ref, description: want.description });
      continue;
    }
    const fields = COMPARED_FIELDS.filter((f) => !sameValue(fieldValue(want, f), fieldValue(have, f)));
    if (fields.length > 0) diff.changes.push({ kind: 'changed', phase, ref: want.ref, description: want.description, fields });
  }

  const expected = desired.map((d) => d.ref).filter((ref) => liveOwned.has(ref));
  if (expected.join('\n') !== liveOrder.join('\n')) diff.changes.push({ kind: 'order', phase, expected, actual: liveOrder });
}

/**
 * Compares one zone. Only the parts the desired state manages are compared: a phase absent
 * from desired.phases, browser_check absent from desired.settings, and bot management absent
 * from desired are left alone. State: `legacy` when any legacy rule is present, else `drift`
 * when any change is found, else `in sync`.
 */
export function diffZone(desired: DesiredZone, live: LiveZone): ZoneDiff {
  const diff: ZoneDiff = { state: 'in sync', changes: [], unowned: [], legacy: [] };
  for (const phase of PHASES) {
    const want = desired.phases[phase];
    if (want === undefined) continue;
    diffPhase(phase, want, live.phases[phase] ?? [], diff);
  }

  for (const [setting, expected] of Object.entries(desired.settings) as [SettingId, unknown][]) {
    if (expected === undefined) continue;
    const actual = live.settings[setting];
    if (!sameValue(expected, actual)) diff.changes.push({ kind: 'setting', setting, expected, actual });
  }

  if (desired.botManagement !== undefined) {
    const actual = live.botManagement;
    const same =
      actual !== undefined &&
      actual.fight_mode === desired.botManagement.fight_mode &&
      actual.enable_js === desired.botManagement.enable_js;
    if (!same) diff.changes.push({ kind: 'bot_management', expected: { ...desired.botManagement }, actual });
  }

  if (diff.legacy.length > 0) diff.state = 'legacy';
  else if (diff.changes.length > 0) diff.state = 'drift';
  return diff;
}

/** The live and wanted value of one field of a `changed` rule. */
export interface FieldValues {
  field: ComparedField;
  live: unknown;
  want: unknown;
}

/** The compared values of each field a `changed` change names; [] when a rule is not found. */
export function changeValues(desired: DesiredZone, live: LiveZone, change: Extract<Change, { kind: 'changed' }>): FieldValues[] {
  const want = desired.phases[change.phase]?.find((r) => r.ref === change.ref);
  const have = live.phases[change.phase]?.find((r) => r.ref === change.ref);
  if (want === undefined || have === undefined) return [];
  return change.fields.map((field) => ({ field, live: fieldValue(have, field), want: fieldValue(want, field) }));
}
