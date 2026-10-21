// Reads live state through CloudflareApi and reports a state for each zone.
// Core module: no Node-only API here, so a Worker can run it.
import type { CloudflareApi, SettingId } from './api.js';
import { diffZone, type LiveZone, type ZoneDiff, type ZoneState } from './diff.js';
import { PHASES, render, type DesiredZone } from './render.js';
import type { Baseline, Inventory } from './schema.js';

/** Reads the parts of one zone's live state that `desired` manages. */
export async function readLiveZone(api: CloudflareApi, zoneId: string, desired: DesiredZone): Promise<LiveZone> {
  const live: LiveZone = { phases: {}, settings: {} };
  for (const phase of PHASES) {
    if (desired.phases[phase] !== undefined) live.phases[phase] = await api.getPhase(zoneId, phase);
  }
  for (const setting of Object.keys(desired.settings) as SettingId[]) {
    live.settings[setting] = await api.getSetting(zoneId, setting);
  }
  if (desired.botManagement !== undefined) live.botManagement = await api.getBotManagement(zoneId);
  return live;
}

/** Renders one inventory zone against its live DNS records, reads its live state, and diffs the two. */
export async function checkZone(
  api: CloudflareApi,
  baseline: Baseline,
  inventory: Inventory,
): Promise<{ desired: DesiredZone; live: LiveZone; diff: ZoneDiff }> {
  const dns = await api.listDnsRecords(inventory.zone_id);
  const desired = render(baseline, inventory, dns);
  const live = await readLiveZone(api, inventory.zone_id, desired);
  return { desired, live, diff: diffZone(desired, live) };
}

export interface ZoneReport {
  zone: string;
  zoneId?: string;
  /** The plan name from listZones; empty when the token does not list the zone. */
  plan: string;
  state: ZoneState;
  diff?: ZoneDiff;
  /** The error message when state is `error`. */
  error?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reports every inventory zone, plus each zone the token can see that has no inventory entry
 * (`not managed`). An error in one zone becomes that zone's `error` state; the other zones still
 * run. `only` narrows the report to the named zones; a named zone found nowhere is an `error`.
 * Rows are sorted by zone name.
 */
export async function statusAll(
  api: CloudflareApi,
  baseline: Baseline,
  inventories: readonly Inventory[],
  only: readonly string[] = [],
): Promise<ZoneReport[]> {
  const visible = await api.listZones();
  const wanted = (name: string) => only.length === 0 || only.includes(name);
  const reports: ZoneReport[] = [];

  for (const inventory of inventories) {
    if (!wanted(inventory.zone)) continue;
    const plan = visible.find((z) => z.id === inventory.zone_id)?.plan ?? '';
    const base = { zone: inventory.zone, zoneId: inventory.zone_id, plan };
    try {
      const { diff } = await checkZone(api, baseline, inventory);
      reports.push({ ...base, state: diff.state, diff });
    } catch (error) {
      reports.push({ ...base, state: 'error', error: message(error) });
    }
  }

  const managedIds = new Set(inventories.map((i) => i.zone_id));
  const managedNames = new Set(inventories.map((i) => i.zone));
  for (const zone of visible) {
    if (managedIds.has(zone.id) || managedNames.has(zone.name) || !wanted(zone.name)) continue;
    reports.push({ zone: zone.name, zoneId: zone.id, plan: zone.plan, state: 'not managed' });
  }

  for (const name of only) {
    if (!reports.some((r) => r.zone === name)) {
      reports.push({ zone: name, plan: '', state: 'error', error: 'no inventory entry, and the token cannot see this zone' });
    }
  }
  return reports.sort((a, b) => a.zone.localeCompare(b.zone));
}

/** The exit code for a set of reports: 2 on any error, 1 on any drift or legacy, else 0. */
export function exitCode(reports: readonly ZoneReport[]): 0 | 1 | 2 {
  if (reports.some((r) => r.state === 'error')) return 2;
  if (reports.some((r) => r.state === 'drift' || r.state === 'legacy')) return 1;
  return 0;
}
