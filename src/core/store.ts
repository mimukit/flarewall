// DataStore: the only door from the core to the flarewall data. The Node CLI implements it over a
// local SQLite file (src/node/sqlite-store.ts); a D1 adapter can implement it later with the same
// SQL (src/core/store-sql.ts).
// Core module: no Node-only API here, so a Worker can run it.
import { z } from 'zod';
import type { ZoneState } from './diff.js';

/** The two document kinds: the one baseline, and one inventory per zone. */
export type DocKind = 'baseline' | 'inventory';
export type RevisionStatus = 'pending' | 'approved' | 'rejected';

/** A document: the baseline (zone null), or the inventory of one zone. */
export interface DocRef {
  kind: DocKind;
  zone: string | null;
}

/** One row of the append-only revisions table. */
export interface Revision {
  id: number;
  kind: DocKind;
  /** The zone name for an inventory; null for the baseline. */
  zone: string | null;
  /** The current revision of the document when this one was written; null for the first. */
  parentId: number | null;
  status: RevisionStatus;
  /** The YAML text. */
  text: string;
  /** The SHA-256 of the text, as lowercase hex. */
  sha256: string;
  /** A source word: `owner`, `skill`, or the `--author` value. */
  author: string;
  message: string | null;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** When a pending revision was approved or rejected. */
  decidedAt: string | null;
}

export interface NewRevision {
  kind: DocKind;
  zone: string | null;
  status: 'pending' | 'approved';
  text: string;
  author: string;
  message?: string | null;
}

/** One row of the backups table. The backup is the ZoneBackup as JSON text. */
export interface BackupRow {
  id: number;
  zone: string;
  zoneId: string;
  createdAt: string;
  backup: string;
}

export interface RunZone {
  zone: string;
  state: ZoneState;
  changes: number;
  error: string | null;
}

export interface Run {
  id: number;
  createdAt: string;
  zones: RunZone[];
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface DataStore {
  /** Where the data lives, for messages and the TUI footer. */
  readonly location: string;
  /** The newest approved revision of a document. */
  current(doc: DocRef): Promise<Revision | undefined>;
  /** The current revision of every zone inventory, by zone name. */
  currentInventories(): Promise<Revision[]>;
  /** Every revision, oldest first; `zone` narrows to one zone's inventory. */
  listRevisions(filter?: { zone?: string }): Promise<Revision[]>;
  getRevision(id: number): Promise<Revision | undefined>;
  /** Pending revisions of a document, oldest first. */
  pending(doc: DocRef): Promise<Revision[]>;
  /**
   * Appends a revision whose parent is the document's current revision. The stamp comes from the
   * store's clock.
   */
  addRevision(revision: NewRevision): Promise<Revision>;
  /**
   * Approves or rejects a pending revision. Approval refuses with a StoreError when the parent is
   * no longer the current revision. The check and the update run in one transaction.
   */
  decide(id: number, status: 'approved' | 'rejected'): Promise<Revision>;
  addBackup(zone: string, zoneId: string, backup: string): Promise<BackupRow>;
  listBackups(zone: string): Promise<BackupRow[]>;
  getBackup(id: number): Promise<BackupRow | undefined>;
  /** Records one drift run with one row per zone. */
  addRun(zones: RunZone[]): Promise<Run>;
  listRuns(): Promise<Run[]>;
  /** True when every table has zero rows. */
  isEmpty(): Promise<boolean>;
  /** Every table, for `flarewall export`. */
  exportData(): Promise<StoreExport>;
  /** Loads an export into an empty store, keeping ids and timestamps. */
  importData(data: StoreExport): Promise<void>;
  close(): void;
}

/** The text of the stale-proposal refusal. */
export function staleMessage(id: number, parent: number | null, current: number | null): string {
  return `revision ${id} is based on ${parent ?? 'nothing'}, but the current revision is ${current ?? 'none'}; propose it again`;
}

/** The document a revision belongs to, as one word: `baseline` or the zone name. */
export function docName(doc: DocRef): string {
  return doc.kind === 'baseline' ? 'baseline' : (doc.zone ?? '');
}

// ---- Export file ----

const revisionRow = z.strictObject({
  id: z.number().int().positive(),
  kind: z.enum(['baseline', 'inventory']),
  zone: z.string().nullable(),
  parent_id: z.number().int().positive().nullable(),
  status: z.enum(['pending', 'approved', 'rejected']),
  text: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  author: z.string(),
  message: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});

const backupRow = z.strictObject({
  id: z.number().int().positive(),
  zone: z.string(),
  zone_id: z.string(),
  created_at: z.string(),
  backup: z.string(),
});

const runRow = z.strictObject({
  id: z.number().int().positive(),
  created_at: z.string(),
});

const runZoneRow = z.strictObject({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  zone: z.string(),
  state: z.string(),
  changes: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

const exportSchema = z.strictObject({
  flarewall_export: z.literal(1),
  schema_version: z.number().int().positive(),
  revisions: z.array(revisionRow),
  backups: z.array(backupRow),
  runs: z.array(runRow),
  run_zones: z.array(runZoneRow),
});

/** The export file: every table, rows in column order, ordered by id. */
export type StoreExport = z.infer<typeof exportSchema>;

/** Parses the text of an export file. Throws StoreError on bad JSON or a bad shape. */
export function parseExport(text: string): StoreExport {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new StoreError(`not valid JSON: ${(error as Error).message}`);
  }
  const result = exportSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new StoreError(`not a flarewall export: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}

/** The export text: two-space JSON with a final newline. Same data, same bytes. */
export function exportText(data: StoreExport): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
