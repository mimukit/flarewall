// apply and restore: plan the writes for one zone, check the Free plan limits, back up, write, read back.
// Core module: no Node-only API here, so a Worker can run it.
import type { BotManagementState, CloudflareApi, LiveRule, SettingId } from './api.js';
import { comparedRatelimit, diffZone, isOwnedRule, sameValue, type Change, type LiveZone, type ZoneDiff } from './diff.js';
import { isLegacyRule, legacyTargetRef } from './legacy.js';
import { PHASES, type DesiredZone, type Phase, type Rule } from './render.js';
import { readLiveZone } from './status.js';

/** The rule fields flarewall sends: a restore keeps only these, and an owned rule carries no others. */
export const WRITABLE_FIELDS = ['id', 'ref', 'description', 'action', 'expression', 'enabled', 'action_parameters', 'ratelimit'] as const;

/** Fields Cloudflare adds on read and rejects or ignores on write. An unowned rule keeps every other field. */
export const READ_ONLY_FIELDS = ['version', 'last_updated', 'categories'] as const;

/** Free plan rule limits per phase, checked on owned plus unowned rules before any write. */
export const FREE_PLAN_LIMITS: Readonly<Record<Phase, number>> = {
  http_request_firewall_custom: 5,
  http_ratelimit: 1,
  http_request_dynamic_redirect: 10,
};

/** The settings a backup holds, in file order. */
export const BACKUP_SETTINGS: readonly SettingId[] = ['always_use_https', 'browser_check'];

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

/** What a phase write does with one rule. */
export type RuleStep =
  | { kind: 'create'; ref: string; description: string; id?: undefined }
  | { kind: 'update'; ref: string; description: string; id?: string }
  | { kind: 'replace'; ref: string; description: string; id?: string; legacy: string }
  | { kind: 'keep'; id?: string; ref?: string; description?: string }
  | { kind: 'remove'; id?: string; ref?: string; description?: string };

export interface PhasePlan {
  phase: Phase;
  /** The full payload for the phase: owned rules in baseline order, then unowned rules. */
  rules: LiveRule[];
  steps: RuleStep[];
  owned: number;
  unowned: number;
  /** False when the phase already matches; no update is sent for it. */
  write: boolean;
}

export interface ZonePlan {
  zone: string;
  phases: PhasePlan[];
  settings: { id: SettingId; live: unknown; want: unknown }[];
  botManagement?: { live: BotManagementState | undefined; want: { fight_mode: boolean; enable_js: boolean } };
  /** One message per phase over a Free plan limit. Any one skips the zone. */
  limitErrors: string[];
  /** True when the plan sends at least one write call. */
  hasWrites: boolean;
}

/** One zone's state as a backup holds it, and as restore sends it back. */
export interface ZoneBackup {
  phases: Partial<Record<Phase, LiveRule[]>>;
  settings: Partial<Record<SettingId, unknown>>;
  botManagement?: BotManagementState;
}

/** Stores a backup for a zone and returns where it went. The Node CLI writes files; tests can keep it in memory. */
export type BackupWriter = (zone: string, backup: ZoneBackup) => Promise<string>;

export interface ZoneRef {
  name: string;
  id: string;
}

export interface WriteOptions {
  /** False (the default) sends no write call. */
  write?: boolean;
  backup: BackupWriter;
  /** Called with the plan before any write, so the caller can print it. */
  onPlan?: (plan: ZonePlan) => void;
  /** Asked once per zone in write mode; false skips the zone. Absent means yes. */
  confirm?: (zone: string) => Promise<boolean>;
}

export interface ApplyResult {
  outcome: 'dry run' | 'no change' | 'applied' | 'declined';
  plan: ZonePlan;
  backupPath?: string;
}

function pick(rule: LiveRule | Rule, fields: readonly string[]): LiveRule {
  const out: LiveRule = {};
  for (const field of fields) {
    const value = (rule as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = structuredClone(value);
  }
  return out;
}

/** The rule with only the writable fields. */
export function writableRule(rule: LiveRule | Rule): LiveRule {
  return pick(rule, WRITABLE_FIELDS);
}

/** An unowned rule as flarewall sends it back: every field except the read-only ones. */
function keptRule(rule: LiveRule): LiveRule {
  const out: LiveRule = {};
  for (const [field, value] of Object.entries(rule)) {
    if (value !== undefined && !(READ_ONLY_FIELDS as readonly string[]).includes(field)) out[field] = structuredClone(value);
  }
  return out;
}

function identity(rule: LiveRule): { id?: string; ref?: string; description?: string } {
  const out: { id?: string; ref?: string; description?: string } = {};
  if (typeof rule.id === 'string') out.id = rule.id;
  if (typeof rule.ref === 'string') out.ref = rule.ref;
  if (typeof rule.description === 'string') out.description = rule.description;
  return out;
}

function changesPhase(change: Change, phase: Phase): boolean {
  return 'phase' in change && change.phase === phase;
}

function planPhase(phase: Phase, desired: Rule[], live: LiveRule[], diff: ZoneDiff): PhasePlan {
  const owned = new Map<string, LiveRule>();
  const legacy = new Map<string, LiveRule>();
  const unowned: LiveRule[] = [];
  const leftover: LiveRule[] = [];
  for (const rule of live) {
    if (isLegacyRule(rule)) {
      const target = legacyTargetRef(rule);
      if (target !== undefined && !legacy.has(target)) legacy.set(target, rule);
      else leftover.push(rule);
    } else if (isOwnedRule(rule)) {
      if (owned.has(rule.ref as string)) leftover.push(rule);
      else owned.set(rule.ref as string, rule);
    } else {
      unowned.push(rule);
    }
  }

  const rules: LiveRule[] = [];
  const steps: RuleStep[] = [];
  const used = new Set<LiveRule>();
  for (const want of desired) {
    const mine = owned.get(want.ref);
    const old = legacy.get(want.ref);
    const source = mine ?? old;
    const id = typeof source?.id === 'string' ? source.id : undefined;
    rules.push({ ...(id !== undefined ? { id } : {}), ...writableRule({ ...want, id: undefined }) });
    if (source !== undefined) used.add(source);
    const base = { ref: want.ref, description: want.description, ...(id !== undefined ? { id } : {}) };
    if (mine !== undefined) steps.push({ kind: 'update', ...base });
    else if (old !== undefined) steps.push({ kind: 'replace', ...base, legacy: old.description ?? old.ref ?? '' });
    else steps.push({ kind: 'create', ref: want.ref, description: want.description });
  }
  for (const rule of unowned) {
    rules.push(keptRule(rule));
    steps.push({ kind: 'keep', ...identity(rule) });
  }
  // Owned rules the baseline no longer renders, duplicates, and legacy rules no owned rule took over.
  for (const rule of [...owned.values(), ...legacy.values(), ...leftover]) {
    if (!used.has(rule)) steps.push({ kind: 'remove', ...identity(rule) });
  }

  const write = diff.changes.some((c) => changesPhase(c, phase)) || diff.legacy.some((l) => l.phase === phase);
  return { phase, rules, steps, owned: desired.length, unowned: unowned.length, write };
}

/**
 * Plans the writes that bring `live` to `desired`. Per managed phase the payload holds the desired
 * owned rules in baseline order, each with the id of the live rule it replaces (an owned rule with
 * the same ref, else the legacy rule it takes over), then the unowned rules in their current order.
 * Settings and Bot Fight Mode are written only where desired holds them and live differs.
 */
export function planZone(desired: DesiredZone, live: LiveZone): ZonePlan {
  const diff = diffZone(desired, live);
  const phases: PhasePlan[] = [];
  const limitErrors: string[] = [];
  for (const phase of PHASES) {
    const want = desired.phases[phase];
    if (want === undefined) continue;
    const plan = planPhase(phase, want, live.phases[phase] ?? [], diff);
    phases.push(plan);
    const limit = FREE_PLAN_LIMITS[phase];
    if (plan.rules.length > limit) {
      limitErrors.push(
        `${phase} would hold ${plan.rules.length} rules (${plan.owned} owned + ${plan.unowned} unowned); the Free plan allows ${limit}`,
      );
    }
  }

  const settings: ZonePlan['settings'] = [];
  for (const [id, want] of Object.entries(desired.settings) as [SettingId, unknown][]) {
    if (want !== undefined && !sameValue(want, live.settings[id])) settings.push({ id, live: live.settings[id], want });
  }

  const plan: ZonePlan = { zone: desired.zone, phases, settings, limitErrors, hasWrites: false };
  const bot = desired.botManagement;
  if (bot !== undefined) {
    const actual = live.botManagement;
    if (actual?.fight_mode !== bot.fight_mode || actual?.enable_js !== bot.enable_js) {
      // Cloudflare rejects fight_mode without enable_js, so both always go together.
      plan.botManagement = { live: actual, want: { fight_mode: bot.fight_mode, enable_js: bot.enable_js } };
    }
  }
  plan.hasWrites = phases.some((p) => p.write) || settings.length > 0 || plan.botManagement !== undefined;
  return plan;
}

/** Reads the state a backup holds: the given phases, both settings, and Bot Fight Mode. */
export async function readBackupState(api: CloudflareApi, zoneId: string, phases: readonly Phase[]): Promise<ZoneBackup> {
  const backup: ZoneBackup = { phases: {}, settings: {} };
  for (const phase of phases) backup.phases[phase] = await api.getPhase(zoneId, phase);
  for (const id of BACKUP_SETTINGS) backup.settings[id] = await api.getSetting(zoneId, id);
  backup.botManagement = await api.getBotManagement(zoneId);
  return backup;
}

function changeText(c: Change): string {
  switch (c.kind) {
    case 'missing':
    case 'extra':
      return `${c.phase}: ${c.kind} ${c.ref}`;
    case 'changed':
      return `${c.phase}: changed ${c.ref} (${c.fields.join(', ')})`;
    case 'order':
      return `${c.phase}: order is ${c.actual.join(', ')}`;
    case 'setting':
      return `setting ${c.setting}`;
    case 'bot_management':
      return 'bot management';
  }
}

/**
 * Applies `desired` to one zone. Dry run (the default): reads, plans, and sends no write call.
 * Write mode: asks `confirm`, writes the backup, sends the phase updates, the setting edits, and
 * the Bot Fight Mode update, then reads back. Throws ApplyError on a Free plan limit breach (before
 * any write) and on a read-back that is not `in sync`.
 */
export async function applyZone(api: CloudflareApi, zone: ZoneRef, desired: DesiredZone, opts: WriteOptions): Promise<ApplyResult> {
  const live = await readLiveZone(api, zone.id, desired);
  const plan = planZone(desired, live);
  opts.onPlan?.(plan);
  if (plan.limitErrors.length > 0) throw new ApplyError(`skipped, over the Free plan limit: ${plan.limitErrors.join('; ')}`);
  if (!plan.hasWrites) return { outcome: 'no change', plan };
  if (opts.write !== true) return { outcome: 'dry run', plan };
  if (opts.confirm !== undefined && !(await opts.confirm(zone.name))) return { outcome: 'declined', plan };

  const backupPath = await opts.backup(zone.name, await readBackupState(api, zone.id, plan.phases.map((p) => p.phase)));
  for (const phase of plan.phases) {
    if (phase.write) await api.updatePhase(zone.id, phase.phase, phase.rules);
  }
  for (const setting of plan.settings) await api.editSetting(zone.id, setting.id, setting.want);
  if (plan.botManagement !== undefined) await api.updateBotManagement(zone.id, plan.botManagement.want);

  const after = diffZone(desired, await readLiveZone(api, zone.id, desired));
  if (after.state !== 'in sync') {
    const detail = [...after.legacy.map((l) => `${l.phase}: legacy ${l.description ?? l.ref ?? ''}`), ...after.changes.map(changeText)];
    throw new ApplyError(`read-back is ${after.state}, not in sync: ${detail.join('; ')} (backup: ${backupPath})`);
  }
  return { outcome: 'applied', plan, backupPath };
}

export interface RestorePlan {
  zone: string;
  phases: { phase: Phase; rules: LiveRule[] }[];
  settings: { id: SettingId; value: unknown }[];
  botManagement?: { fight_mode: boolean; enable_js: boolean };
}

export interface RestoreResult {
  outcome: 'dry run' | 'restored' | 'declined';
  plan: RestorePlan;
  backupPath?: string;
}

/** The payload restore sends for a backup: each phase's rules, the settings, Bot Fight Mode. */
export function planRestore(zone: string, backup: ZoneBackup): RestorePlan {
  const plan: RestorePlan = { zone, phases: [], settings: [] };
  for (const phase of PHASES) {
    const rules = backup.phases[phase];
    // Owned and legacy rules go back on the writable allowlist. An unowned rule keeps every field
    // but the read-only ones, as apply sends it, so a hand-made rule's `logging` survives a restore.
    if (rules !== undefined) {
      plan.phases.push({ phase, rules: rules.map((r) => (isOwnedRule(r) || isLegacyRule(r) ? writableRule(r) : keptRule(r))) });
    }
  }
  for (const id of BACKUP_SETTINGS) {
    if (backup.settings[id] !== undefined) plan.settings.push({ id, value: backup.settings[id] });
  }
  if (backup.botManagement !== undefined) {
    plan.botManagement = { fight_mode: backup.botManagement.fight_mode ?? false, enable_js: backup.botManagement.enable_js ?? false };
  }
  return plan;
}

/** A rule's compared form for the restore read-back: writable fields, enabled defaults to true, ratelimit narrowed. */
function restoredForm(rule: LiveRule, withId: boolean): LiveRule {
  const out = writableRule(rule);
  if (!withId) delete out.id;
  out.enabled = rule.enabled ?? true;
  if (out.ratelimit !== undefined) out.ratelimit = comparedRatelimit(out.ratelimit);
  return out;
}

function sameRules(want: LiveRule[], have: LiveRule[]): boolean {
  if (want.length !== have.length) return false;
  return want.every((w, i) => {
    const h = have[i];
    // A backed-up rule with no id cannot pin the id Cloudflare gives it.
    return h !== undefined && sameValue(restoredForm(w, w.id !== undefined), restoredForm(h, w.id !== undefined));
  });
}

/**
 * Sends a backup back to one zone. Dry run (the default) sends no write call. Write mode asks
 * `confirm`, writes a fresh backup of the current state, sends every backed-up phase, setting, and
 * the Bot Fight Mode values, then reads back and compares with the backup on the writable allowlist.
 */
export async function restoreZone(
  api: CloudflareApi,
  zone: ZoneRef,
  backup: ZoneBackup,
  opts: Omit<WriteOptions, 'onPlan'> & { onPlan?: (plan: RestorePlan) => void },
): Promise<RestoreResult> {
  const plan = planRestore(zone.name, backup);
  opts.onPlan?.(plan);
  if (opts.write !== true) return { outcome: 'dry run', plan };
  if (opts.confirm !== undefined && !(await opts.confirm(zone.name))) return { outcome: 'declined', plan };

  const backupPath = await opts.backup(zone.name, await readBackupState(api, zone.id, plan.phases.map((p) => p.phase)));
  for (const phase of plan.phases) await api.updatePhase(zone.id, phase.phase, phase.rules);
  for (const setting of plan.settings) await api.editSetting(zone.id, setting.id, setting.value);
  if (plan.botManagement !== undefined) await api.updateBotManagement(zone.id, plan.botManagement);

  const mismatches: string[] = [];
  for (const phase of plan.phases) {
    if (!sameRules(phase.rules, await api.getPhase(zone.id, phase.phase))) mismatches.push(phase.phase);
  }
  for (const setting of plan.settings) {
    if (!sameValue(setting.value, await api.getSetting(zone.id, setting.id))) mismatches.push(`setting ${setting.id}`);
  }
  if (plan.botManagement !== undefined) {
    const bot = await api.getBotManagement(zone.id);
    if (bot.fight_mode !== plan.botManagement.fight_mode || bot.enable_js !== plan.botManagement.enable_js) mismatches.push('bot management');
  }
  if (mismatches.length > 0) {
    throw new ApplyError(`read-back differs from the backup: ${mismatches.join(', ')} (fresh backup: ${backupPath})`);
  }
  return { outcome: 'restored', plan, backupPath };
}
