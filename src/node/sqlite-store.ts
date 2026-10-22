// Node-only adapter: the DataStore on one local SQLite file, through node:sqlite.
// The file holds private data, so it gets mode 0600 in a 0700 directory. The journal mode is
// DELETE, so a plain copy of the one file while no flarewall command runs is a full backup.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ZoneState } from '../core/diff.js';
import { EXPORT_TABLES, MIGRATIONS, SCHEMA_VERSION, SQL, type ExportTable } from '../core/store-sql.js';
import {
  StoreError,
  staleMessage,
  type BackupRow,
  type DataStore,
  type DocKind,
  type DocRef,
  type NewRevision,
  type Revision,
  type RevisionStatus,
  type Run,
  type RunZone,
  type StoreExport,
} from '../core/store.js';

/** The in-memory database, for tests. */
export const MEMORY = ':memory:';

/** Wait this long for a lock held by another flarewall process before failing. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The database file: FLAREWALL_DB, else $XDG_DATA_HOME/flarewall/flarewall.sqlite, else
 * ~/.local/share/flarewall/flarewall.sqlite.
 */
export function resolveDbPath(env: Record<string, string | undefined>): string {
  if (env.FLAREWALL_DB !== undefined && env.FLAREWALL_DB !== '') return env.FLAREWALL_DB;
  const dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== '' ? env.XDG_DATA_HOME : join(env.HOME || homedir(), '.local', 'share');
  return join(dataHome, 'flarewall', 'flarewall.sqlite');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface OpenOptions {
  /** Create the file and its directory when missing (init and import). Default: false. */
  create?: boolean;
  /** The clock for every timestamp. Default: the system clock. */
  now?: () => Date;
}

type Row = Record<string, SQLInputValue>;

function toRevision(row: Row): Revision {
  return {
    id: Number(row.id),
    kind: row.kind as DocKind,
    zone: row.zone as string | null,
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    status: row.status as RevisionStatus,
    text: row.text as string,
    sha256: row.sha256 as string,
    author: row.author as string,
    message: row.message as string | null,
    createdAt: row.created_at as string,
    decidedAt: row.decided_at as string | null,
  };
}

function toBackup(row: Row): BackupRow {
  return { id: Number(row.id), zone: row.zone as string, zoneId: row.zone_id as string, createdAt: row.created_at as string, backup: row.backup as string };
}

/** Creates the file with mode 0600 (and its directory with 0700) when it is missing. */
function createFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
}

/**
 * Opens the store at `path` (or MEMORY), applies the missing migrations, and checks the schema
 * version. Throws StoreError when the file is missing and `create` is not set, and when the file
 * comes from a newer flarewall.
 */
export function openSqliteStore(path: string, options: OpenOptions = {}): DataStore {
  const now = options.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  if (path !== MEMORY) {
    if (!existsSync(path)) {
      if (options.create !== true) throw new StoreError(`no flarewall database at ${path}; run flarewall init`);
      createFile(path);
    }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  /** Runs `body` in one BEGIN IMMEDIATE transaction: it takes the write lock before the first read. */
  const immediate = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
  const one = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;
  const current = (doc: DocRef) => {
    const row = one(SQL.currentRevision, doc.kind, doc.zone);
    return row === undefined ? undefined : toRevision(row);
  };

  return {
    location: path,
    current: async (doc) => current(doc),
    currentInventories: async () => all(SQL.currentInventories).map(toRevision),
    listRevisions: async (filter = {}) =>
      (filter.zone === undefined ? all(SQL.listRevisions) : all(SQL.listZoneRevisions, filter.zone)).map(toRevision),
    getRevision: async (id) => {
      const row = one(SQL.getRevision, id);
      return row === undefined ? undefined : toRevision(row);
    },
    pending: async (doc) => all(SQL.pendingRevisions, doc.kind, doc.zone).map(toRevision),
    addRevision: async (revision: NewRevision) =>
      immediate(() => {
        if ((revision.kind === 'baseline') !== (revision.zone === null)) throw new StoreError('a baseline revision has no zone, and an inventory revision has one');
        const at = stamp();
        const parent = current(revision);
        const row = one(
          SQL.insertRevision,
          revision.kind,
          revision.zone,
          parent?.id ?? null,
          revision.status,
          revision.text,
          sha256(revision.text),
          revision.author,
          revision.message ?? null,
          at,
          revision.status === 'approved' ? at : null,
        );
        return toRevision(row as Row);
      }),
    decide: async (id, status) =>
      immediate(() => {
        const row = one(SQL.getRevision, id);
        if (row === undefined) throw new StoreError(`no revision ${id}`);
        const revision = toRevision(row);
        if (revision.status !== 'pending') throw new StoreError(`revision ${id} is ${revision.status}, not pending`);
        if (status === 'approved') {
          const head = current(revision);
          if ((head?.id ?? null) !== revision.parentId) throw new StoreError(staleMessage(id, revision.parentId, head?.id ?? null));
        }
        return toRevision(one(SQL.decideRevision, status, stamp(), id) as Row);
      }),
    addBackup: async (zone, zoneId, backup) => toBackup(one(SQL.insertBackup, zone, zoneId, stamp(), backup) as Row),
    listBackups: async (zone) => all(SQL.listBackups, zone).map(toBackup),
    getBackup: async (id) => {
      const row = one(SQL.getBackup, id);
      return row === undefined ? undefined : toBackup(row);
    },
    addRun: async (zones: RunZone[]) =>
      immediate(() => {
        const run = one(SQL.insertRun, stamp()) as Row;
        const insert = db.prepare(SQL.insertRunZone);
        for (const z of zones) insert.run(run.id as number, z.zone, z.state, z.changes, z.error);
        return { id: Number(run.id), createdAt: run.created_at as string, zones };
      }),
    listRuns: async () => {
      const zones = all(SQL.listRunZones);
      return all(SQL.listRuns).map(
        (run): Run => ({
          id: Number(run.id),
          createdAt: run.created_at as string,
          zones: zones
            .filter((z) => z.run_id === run.id)
            .map((z) => ({ zone: z.zone as string, state: z.state as ZoneState, changes: Number(z.changes), error: z.error as string | null })),
        }),
      );
    },
    isEmpty: async () => isEmpty(db),
    exportData: async () => {
      const rows = (table: ExportTable) => all(SQL.exportRows(table));
      // Build each row in column order, so the export has a fixed key order.
      const ordered = (table: ExportTable) =>
        rows(table).map((row) => Object.fromEntries(EXPORT_TABLES[table].map((column) => [column, row[column] ?? null])));
      return {
        flarewall_export: 1,
        schema_version: SCHEMA_VERSION,
        revisions: ordered('revisions'),
        backups: ordered('backups'),
        runs: ordered('runs'),
        run_zones: ordered('run_zones'),
      } as StoreExport;
    },
    importData: async (data) =>
      immediate(() => {
        if (data.schema_version !== SCHEMA_VERSION) {
          throw new StoreError(`the export has schema version ${data.schema_version}, but this flarewall writes ${SCHEMA_VERSION}`);
        }
        if (!isEmpty(db)) throw new StoreError(`${path} is not empty; flarewall import loads into an empty database only`);
        for (const table of Object.keys(EXPORT_TABLES) as ExportTable[]) {
          const insert = db.prepare(SQL.importRow(table));
          for (const row of data[table]) {
            insert.run(...EXPORT_TABLES[table].map((column) => (row as Record<string, SQLInputValue>)[column] ?? null));
          }
        }
      }),
    close: () => db.close(),
  };
}

function isEmpty(db: DatabaseSync): boolean {
  return (Object.keys(EXPORT_TABLES) as ExportTable[]).every((table) => (db.prepare(SQL.countRows(table)).get() as Row).n === 0);
}

/** Applies the missing migrations in order, each in one transaction with its version bump. */
function migrate(db: DatabaseSync): void {
  const version = () => {
    if ((db.prepare(SQL.hasMeta).get() as Row).n === 0) return 0;
    const row = db.prepare(SQL.getVersion).get() as Row | undefined;
    return row === undefined ? 0 : Number(row.value);
  };
  let at = version();
  if (at > SCHEMA_VERSION) throw new StoreError('the database schema is newer than this flarewall; upgrade flarewall');
  while (at < SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read again inside the lock: another process may have migrated meanwhile.
      at = version();
      if (at < SCHEMA_VERSION) {
        db.exec(MIGRATIONS[at] as string);
        db.prepare(SQL.setVersion).run(String(at + 1));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    at = version();
  }
}
