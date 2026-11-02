// The schema, the migrations, and every query of the data store, in the SQLite dialect. The Node
// adapter (src/node/sqlite-store.ts) runs them on node:sqlite; a later D1 adapter can run the same
// text. Parameters are positional (`?`).
// Core module: no Node-only API here, so a Worker can run it.

/**
 * The migrations, in order. Migration i moves the schema from version i to version i + 1. Never
 * edit a migration that has shipped; add a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'inventory')),
  zone TEXT,
  parent_id INTEGER REFERENCES revisions (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  text TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  author TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK ((kind = 'baseline') = (zone IS NULL))
);
CREATE INDEX revisions_doc ON revisions (kind, zone, status, id);

-- Append-only: a row never goes away, and only a pending row may change, and then only its
-- status and decided_at.
CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are append-only');
END;
CREATE TRIGGER revisions_decide_only BEFORE UPDATE ON revisions
WHEN OLD.status <> 'pending'
  OR NEW.status = 'pending'
  OR NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.zone IS NOT OLD.zone
  OR NEW.parent_id IS NOT OLD.parent_id
  OR NEW.text IS NOT OLD.text
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.author IS NOT OLD.author
  OR NEW.message IS NOT OLD.message
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'revisions are append-only; only a pending revision can be decided');
END;

CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  zone TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  backup TEXT NOT NULL
);
CREATE INDEX backups_zone ON backups (zone, id);
CREATE TRIGGER backups_no_change BEFORE UPDATE ON backups
BEGIN
  SELECT RAISE(ABORT, 'backups are append-only');
END;
CREATE TRIGGER backups_no_delete BEFORE DELETE ON backups
BEGIN
  SELECT RAISE(ABORT, 'backups are append-only');
END;

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE run_zones (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  zone TEXT NOT NULL,
  state TEXT NOT NULL,
  changes INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX run_zones_run ON run_zones (run_id, id);
CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
BEGIN
  SELECT RAISE(ABORT, 'runs are append-only');
END;
CREATE TRIGGER run_zones_no_delete BEFORE DELETE ON run_zones
BEGIN
  SELECT RAISE(ABORT, 'runs are append-only');
END;
`,
];

/** The schema version this flarewall writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** The tables in export order, each with its columns in export order. */
export const EXPORT_TABLES = {
  revisions: ['id', 'kind', 'zone', 'parent_id', 'status', 'text', 'sha256', 'author', 'message', 'created_at', 'decided_at'],
  backups: ['id', 'zone', 'zone_id', 'created_at', 'backup'],
  runs: ['id', 'created_at'],
  run_zones: ['id', 'run_id', 'zone', 'state', 'changes', 'error'],
} as const;

export type ExportTable = keyof typeof EXPORT_TABLES;

const REVISION_COLUMNS = EXPORT_TABLES.revisions.join(', ');

export const SQL = {
  /** 1 when the meta table exists. */
  hasMeta: `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'`,
  getVersion: `SELECT value FROM meta WHERE key = 'schema_version'`,
  setVersion: `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,

  currentRevision: `SELECT ${REVISION_COLUMNS} FROM revisions WHERE kind = ? AND zone IS ? AND status = 'approved' ORDER BY id DESC LIMIT 1`,
  currentInventories: `SELECT ${REVISION_COLUMNS} FROM revisions r WHERE kind = 'inventory' AND status = 'approved'
  AND id = (SELECT max(id) FROM revisions s WHERE s.kind = 'inventory' AND s.zone = r.zone AND s.status = 'approved')
  ORDER BY zone`,
  listRevisions: `SELECT ${REVISION_COLUMNS} FROM revisions ORDER BY id`,
  listZoneRevisions: `SELECT ${REVISION_COLUMNS} FROM revisions WHERE kind = 'inventory' AND zone = ? ORDER BY id`,
  getRevision: `SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = ?`,
  pendingRevisions: `SELECT ${REVISION_COLUMNS} FROM revisions WHERE kind = ? AND zone IS ? AND status = 'pending' ORDER BY id`,
  insertRevision: `INSERT INTO revisions (kind, zone, parent_id, status, text, sha256, author, message, created_at, decided_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${REVISION_COLUMNS}`,
  decideRevision: `UPDATE revisions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING ${REVISION_COLUMNS}`,

  insertBackup: `INSERT INTO backups (zone, zone_id, created_at, backup) VALUES (?, ?, ?, ?) RETURNING id, zone, zone_id, created_at, backup`,
  listBackups: `SELECT id, zone, zone_id, created_at, backup FROM backups WHERE zone = ? ORDER BY id`,
  getBackup: `SELECT id, zone, zone_id, created_at, backup FROM backups WHERE id = ?`,

  insertRun: `INSERT INTO runs (created_at) VALUES (?) RETURNING id, created_at`,
  insertRunZone: `INSERT INTO run_zones (run_id, zone, state, changes, error) VALUES (?, ?, ?, ?, ?)`,
  listRuns: `SELECT id, created_at FROM runs ORDER BY id`,
  listRunZones: `SELECT id, run_id, zone, state, changes, error FROM run_zones ORDER BY run_id, id`,

  /** Every row of a table, in export column order, ordered by id. */
  exportRows: (table: ExportTable) => `SELECT ${EXPORT_TABLES[table].join(', ')} FROM ${table} ORDER BY id`,
  importRow: (table: ExportTable) =>
    `INSERT INTO ${table} (${EXPORT_TABLES[table].join(', ')}) VALUES (${EXPORT_TABLES[table].map(() => '?').join(', ')})`,
  countRows: (table: ExportTable) => `SELECT count(*) AS n FROM ${table}`,
} as const;
