// The revision steps every caller shares: read the current data set, save an owner revision,
// propose, revert, add a zone, and the store-backed backup writer. The CLI and the TUI call these;
// the store keeps the rows.
// Core module: no Node-only API here, so a Worker can run it.
import type { CloudflareApi, LiveRule, SettingId } from './api.js';
import { BACKUP_SETTINGS, type BackupWriter, type ZoneBackup } from './apply.js';
import { PHASES } from './render.js';
import { parseBaseline, parseInventory, type Baseline, type Inventory } from './schema.js';
import type { ZoneReport } from './status.js';
import { docName, type DataStore, type DocRef, type Revision, type RunZone } from './store.js';

/** A data problem the owner can fix: a missing baseline, a bad revision, a refused step. */
export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export interface DataSet {
  baseline: Baseline;
  inventories: Inventory[];
}

/** Validates a document text with the Zod schemas. An inventory must name its own zone. */
export function parseDoc(doc: DocRef, text: string): Baseline | Inventory {
  if (doc.kind === 'baseline') return parseBaseline(text);
  const inventory = parseInventory(text);
  if (inventory.zone !== doc.zone) throw new Error(`the inventory names zone ${inventory.zone}, not ${doc.zone}`);
  return inventory;
}

function revisionLabel(revision: Revision): string {
  return `revision ${revision.id} (${revision.kind === 'baseline' ? 'baseline' : `${revision.zone} inventory`})`;
}

/**
 * The current baseline and every current inventory. Throws DataError when there is no baseline,
 * when a revision does not parse, and when two zones share a zone id.
 */
export async function loadDataSet(store: DataStore): Promise<DataSet> {
  const base = await store.current({ kind: 'baseline', zone: null });
  if (base === undefined) throw new DataError(`the database at ${store.location} holds no baseline; run flarewall init`);
  const parse = <T>(revision: Revision, fn: (text: string) => T): T => {
    try {
      return fn(revision.text);
    } catch (error) {
      throw new DataError(`${revisionLabel(revision)}: ${(error as Error).message}`);
    }
  };
  const baseline = parse(base, parseBaseline);
  const inventories: Inventory[] = [];
  const seen = new Map<string, string>();
  for (const revision of await store.currentInventories()) {
    const inventory = parse(revision, (text) => parseDoc(revision, text) as Inventory);
    const other = seen.get(inventory.zone_id);
    if (other !== undefined) throw new DataError(`${revisionLabel(revision)}: zone id ${inventory.zone_id} is also the id of ${other}`);
    seen.set(inventory.zone_id, inventory.zone);
    inventories.push(inventory);
  }
  return { baseline, inventories };
}

/** A saved revision and the pending revisions of its document that are now stale. */
export interface Saved {
  revision: Revision;
  stale: number[];
}

/**
 * Validates `text` and saves it as an approved owner revision. Refuses text identical to the
 * current revision. Pending revisions of the document still exist and are named as stale.
 */
export async function saveOwnerRevision(store: DataStore, doc: DocRef, text: string, message?: string | null): Promise<Saved> {
  try {
    parseDoc(doc, text);
  } catch (error) {
    throw new DataError(`${docName(doc)}: ${(error as Error).message}`);
  }
  const current = await store.current(doc);
  if (current !== undefined && current.text === text) throw new DataError(`${docName(doc)}: no change`);
  const revision = await store.addRevision({ ...doc, status: 'approved', text, author: 'owner', message: message ?? null });
  return { revision, stale: (await store.pending(doc)).map((r) => r.id) };
}

/**
 * Writes a pending revision for the owner to approve. Refuses a zone with no current inventory, a
 * text that does not validate, and a text identical to the current revision.
 */
export async function proposeRevision(store: DataStore, doc: DocRef, text: string, author: string, message?: string | null): Promise<Revision> {
  const current = await store.current(doc);
  if (current === undefined) {
    throw new DataError(doc.kind === 'baseline' ? 'no baseline yet; run flarewall init first' : `run flarewall add ${doc.zone} first`);
  }
  try {
    parseDoc(doc, text);
  } catch (error) {
    throw new DataError(`${docName(doc)}: ${(error as Error).message}`);
  }
  if (current.text === text) throw new DataError(`${docName(doc)}: no change`);
  return store.addRevision({ ...doc, status: 'pending', text, author, message: message ?? null });
}

/** Writes a new approved revision with the text of an older approved one. Deletes nothing. */
export async function revertTo(store: DataStore, id: number, message?: string | null): Promise<Saved> {
  const target = await store.getRevision(id);
  if (target === undefined) throw new DataError(`no revision ${id}`);
  if (target.status !== 'approved') throw new DataError(`revision ${id} is ${target.status}; only an approved revision can be restored`);
  return saveOwnerRevision(store, target, target.text, message ?? `revert to ${id}`);
}

/** The text of a new inventory. The proxied hostnames go in as comments for the owner to sort. */
export function newInventoryText(zone: string, zoneId: string, proxiedHosts: readonly string[]): string {
  const lines = [
    `# Inventory for ${zone}, written by flarewall add.`,
    '# Put each host below in hosts.api or hosts.wordpress where it fits, then check redirects.',
    '# Proxied hostnames in this zone:',
    ...(proxiedHosts.length > 0 ? proxiedHosts.map((h) => `#   ${h}`) : ['#   (none)']),
    'version: 1',
    `zone: ${zone}`,
    `zone_id: "${zoneId}"`,
    'hosts:',
    '  api: []',
    '  wordpress: []',
    'redirects: root',
    '',
  ];
  return lines.join('\n');
}

/**
 * Writes the first inventory revision for a zone the token can see, approved, by the owner.
 * Refuses when the zone is not visible or already has a current inventory.
 */
export async function addZoneInventory(api: CloudflareApi, store: DataStore, zoneName: string): Promise<Revision> {
  const zone = (await api.listZones()).find((z) => z.name === zoneName);
  if (zone === undefined) throw new DataError(`zone ${zoneName} not found: the token cannot see it`);
  const doc: DocRef = { kind: 'inventory', zone: zone.name };
  const current = await store.current(doc);
  if (current !== undefined) throw new DataError(`${zone.name} already has inventory revision ${current.id}; flarewall add does not overwrite it`);
  const records = await api.listDnsRecords(zone.id);
  const hosts = [...new Set(records.filter((r) => r.proxied).map((r) => r.name))].sort();
  return store.addRevision({ ...doc, status: 'approved', text: newInventoryText(zone.name, zone.id, hosts), author: 'owner', message: 'flarewall add' });
}

/** A BackupWriter that stores each backup as a row and returns `backup <id>`. */
export function storeBackupWriter(store: DataStore): BackupWriter {
  return async (zone, backup) => `backup ${(await store.addBackup(zone.name, zone.id, JSON.stringify(backup))).id}`;
}

/** Reads the ZoneBackup of a backup row. Throws DataError on a row that does not hold one. */
export function parseBackup(id: number, json: string): ZoneBackup {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new DataError(`backup ${id}: not valid JSON: ${(error as Error).message}`);
  }
  const bad = (what: string) => new DataError(`backup ${id}: ${what}`);
  if (value === null || typeof value !== 'object') throw bad('expected a JSON object');
  const raw = value as { phases?: unknown; settings?: unknown; botManagement?: unknown };
  if (raw.phases === null || typeof raw.phases !== 'object' || raw.settings === null || typeof raw.settings !== 'object') {
    throw bad('expected phases and settings objects');
  }
  const backup: ZoneBackup = { phases: {}, settings: {} };
  const phases = raw.phases as Record<string, unknown>;
  for (const phase of PHASES) {
    const rules = phases[phase];
    if (rules === undefined) continue;
    if (!Array.isArray(rules)) throw bad(`${phase}: expected a JSON array of rules`);
    backup.phases[phase] = rules as LiveRule[];
  }
  const settings = raw.settings as Record<string, unknown>;
  for (const setting of BACKUP_SETTINGS) {
    const v = settings[setting];
    if (v !== undefined && v !== null) backup.settings[setting as SettingId] = v;
  }
  if (raw.botManagement !== undefined) backup.botManagement = raw.botManagement as ZoneBackup['botManagement'];
  if (Object.keys(backup.phases).length === 0 && Object.keys(backup.settings).length === 0 && backup.botManagement === undefined) {
    throw bad('holds no phases, settings, or bot management');
  }
  return backup;
}

/** One run row per zone report: the state, the change count (legacy rules included), and the error. */
export function runZones(reports: readonly ZoneReport[]): RunZone[] {
  return reports.map((r) => ({
    zone: r.zone,
    state: r.state,
    changes: (r.diff?.changes.length ?? 0) + (r.diff?.legacy.length ?? 0),
    error: r.error ?? null,
  }));
}

/**
 * A line diff of two texts: `- ` for a removed line, `+ ` for an added one, `  ` for one line of
 * context around each change, and `  ...` where unchanged lines are skipped.
 */
export function textDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence table, from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i++]! });
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ op: '-', line: a[i++]! });
    } else {
      ops.push({ op: '+', line: b[j++]! });
    }
  }
  const near = (k: number) => ops.slice(Math.max(0, k - 1), k + 2).some((o) => o.op !== ' ');
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (o.op !== ' ' || near(k)) {
      out.push(`${o.op} ${o.line}`.trimEnd());
      skipped = false;
    } else if (!skipped) {
      out.push('  ...');
      skipped = true;
    }
  });
  return out;
}
