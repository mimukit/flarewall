// The SQLite data store: append-only revisions, the current revision, the stale-proposal refusal,
// the schema version, backups, runs, export and import, and the file mode.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/core/store-sql.js';
import { exportText, parseExport, type DataStore, type DocRef } from '../src/core/store.js';
import { MEMORY, openSqliteStore, resolveDbPath, sha256 } from '../src/node/sqlite-store.js';

const BASELINE: DocRef = { kind: 'baseline', zone: null };
const COM: DocRef = { kind: 'inventory', zone: 'example.com' };

let tick: number;
const now = () => new Date(Date.UTC(2026, 9, 22, 8, 0, tick++));
let store: DataStore;
let dir: string;

beforeEach(() => {
  tick = 0;
  store = openSqliteStore(MEMORY, { now });
  dir = mkdtempSync(join(tmpdir(), 'flarewall-store-'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('revisions', () => {
  it('appends revisions, and the current one is the newest approved row', async () => {
    const a = await store.addRevision({ ...COM, status: 'approved', text: 'a\n', author: 'owner' });
    const b = await store.addRevision({ ...COM, status: 'approved', text: 'b\n', author: 'owner', message: 'second' });
    const p = await store.addRevision({ ...COM, status: 'pending', text: 'c\n', author: 'skill' });
    expect(a).toMatchObject({ id: 1, parentId: null, status: 'approved', sha256: sha256('a\n'), createdAt: '2026-10-22T08:00:00.000Z' });
    expect(a.decidedAt).toBe(a.createdAt);
    expect(b).toMatchObject({ parentId: 1, message: 'second' });
    expect(p).toMatchObject({ parentId: 2, status: 'pending', decidedAt: null });
    expect((await store.current(COM))?.id).toBe(b.id);
    expect((await store.listRevisions()).map((r) => r.id)).toEqual([1, 2, 3]);
    expect((await store.pending(COM)).map((r) => r.id)).toEqual([3]);
  });

  it('keeps the baseline apart from the inventories, and lists the current inventory of each zone', async () => {
    await store.addRevision({ ...BASELINE, status: 'approved', text: 'base\n', author: 'owner' });
    await store.addRevision({ ...COM, status: 'approved', text: 'com 1\n', author: 'owner' });
    await store.addRevision({ kind: 'inventory', zone: 'example.net', status: 'approved', text: 'net\n', author: 'owner' });
    await store.addRevision({ ...COM, status: 'approved', text: 'com 2\n', author: 'owner' });
    await store.addRevision({ ...COM, status: 'pending', text: 'com 3\n', author: 'skill' });
    expect((await store.current(BASELINE))?.text).toBe('base\n');
    expect((await store.currentInventories()).map((r) => [r.zone, r.text])).toEqual([
      ['example.com', 'com 2\n'],
      ['example.net', 'net\n'],
    ]);
    expect((await store.listRevisions({ zone: 'example.com' })).map((r) => r.id)).toEqual([2, 4, 5]);
  });

  it('refuses to delete or rewrite a revision', async () => {
    const db = openSqliteStore(join(dir, 'f.sqlite'), { create: true, now });
    await db.addRevision({ ...COM, status: 'approved', text: 'a\n', author: 'owner' });
    db.close();
    const raw = new DatabaseSync(join(dir, 'f.sqlite'));
    try {
      expect(() => raw.exec('DELETE FROM revisions')).toThrow(/append-only/);
      expect(() => raw.exec(`UPDATE revisions SET text = 'b' WHERE id = 1`)).toThrow(/append-only/);
      expect(() => raw.exec(`UPDATE revisions SET status = 'rejected' WHERE id = 1`)).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('approves a pending revision whose parent is current', async () => {
    await store.addRevision({ ...COM, status: 'approved', text: 'a\n', author: 'owner' });
    const p = await store.addRevision({ ...COM, status: 'pending', text: 'b\n', author: 'skill' });
    const done = await store.decide(p.id, 'approved');
    expect(done).toMatchObject({ status: 'approved', decidedAt: '2026-10-22T08:00:02.000Z' });
    expect((await store.current(COM))?.id).toBe(p.id);
    await expect(store.decide(p.id, 'rejected')).rejects.toThrow(/is approved, not pending/);
  });

  it('refuses to approve a stale proposal, and the second of two proposals goes stale', async () => {
    await store.addRevision({ ...COM, status: 'approved', text: 'a\n', author: 'owner' });
    const p1 = await store.addRevision({ ...COM, status: 'pending', text: 'b\n', author: 'skill' });
    const p2 = await store.addRevision({ ...COM, status: 'pending', text: 'c\n', author: 'skill' });
    await store.decide(p2.id, 'approved');
    await expect(store.decide(p1.id, 'approved')).rejects.toThrow('revision 2 is based on 1, but the current revision is 3; propose it again');
    expect((await store.getRevision(p1.id))?.status).toBe('pending');
    expect((await store.decide(p1.id, 'rejected')).status).toBe('rejected');
  });

  it('makes a proposal stale when the owner saves a newer revision', async () => {
    await store.addRevision({ ...COM, status: 'approved', text: 'a\n', author: 'owner' });
    const p = await store.addRevision({ ...COM, status: 'pending', text: 'b\n', author: 'skill' });
    await store.addRevision({ ...COM, status: 'approved', text: 'edit\n', author: 'owner' });
    await expect(store.decide(p.id, 'approved')).rejects.toThrow(/propose it again/);
  });
});

describe('backups and runs', () => {
  it('stores a backup and reads it back', async () => {
    const backup = JSON.stringify({ phases: { http_ratelimit: [] }, settings: { always_use_https: 'off' } });
    const row = await store.addBackup('example.com', 'zone-id', backup);
    await store.addBackup('example.net', 'other-id', '{}');
    expect(row).toEqual({ id: 1, zone: 'example.com', zoneId: 'zone-id', createdAt: '2026-10-22T08:00:00.000Z', backup });
    expect(await store.getBackup(1)).toEqual(row);
    expect(await store.listBackups('example.com')).toEqual([row]);
    expect(await store.getBackup(9)).toBeUndefined();
  });

  it('records a drift run with one row per zone', async () => {
    await store.addRun([
      { zone: 'example.com', state: 'drift', changes: 2, error: null },
      { zone: 'example.net', state: 'error', changes: 0, error: 'boom' },
    ]);
    expect(await store.listRuns()).toEqual([
      {
        id: 1,
        createdAt: '2026-10-22T08:00:00.000Z',
        zones: [
          { zone: 'example.com', state: 'drift', changes: 2, error: null },
          { zone: 'example.net', state: 'error', changes: 0, error: 'boom' },
        ],
      },
    ]);
  });
});

describe('the file', () => {
  it('refuses a missing file unless asked to create it', () => {
    const path = join(dir, 'nope.sqlite');
    expect(() => openSqliteStore(path)).toThrow(`no flarewall database at ${path}; run flarewall init`);
  });

  it('creates the file with mode 0600 in a 0700 directory, with the DELETE journal', async () => {
    const path = join(dir, 'sub', 'flarewall.sqlite');
    const db = openSqliteStore(path, { create: true, now });
    await db.addRevision({ ...BASELINE, status: 'approved', text: 'x\n', author: 'owner' });
    db.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'sub')).mode & 0o777).toBe(0o700);
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally {
      raw.close();
    }
  });

  it('sets the schema version, and stops on a file from a newer flarewall', () => {
    const path = join(dir, 'f.sqlite');
    openSqliteStore(path, { create: true }).close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: String(SCHEMA_VERSION) });
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    raw.close();
    expect(() => openSqliteStore(path)).toThrow('the database schema is newer than this flarewall; upgrade flarewall');
  });

  it('applies the migrations to an older (empty) file', async () => {
    const path = join(dir, 'old.sqlite');
    writeFileSync(path, '');
    const db = openSqliteStore(path);
    expect(await db.isEmpty()).toBe(true);
    db.close();
  });

  it('resolves the path from FLAREWALL_DB, then XDG_DATA_HOME, then HOME', () => {
    expect(resolveDbPath({ FLAREWALL_DB: '/x/y.sqlite', XDG_DATA_HOME: '/d' })).toBe('/x/y.sqlite');
    expect(resolveDbPath({ XDG_DATA_HOME: '/d', HOME: '/h' })).toBe('/d/flarewall/flarewall.sqlite');
    expect(resolveDbPath({ HOME: '/h' })).toBe('/h/.local/share/flarewall/flarewall.sqlite');
  });
});

describe('export and import', () => {
  it('round-trips every table byte for byte, keeping ids and timestamps', async () => {
    await store.addRevision({ ...BASELINE, status: 'approved', text: 'base\n', author: 'owner' });
    await store.addRevision({ ...COM, status: 'approved', text: 'a\n', author: 'owner' });
    const p = await store.addRevision({ ...COM, status: 'pending', text: 'b\n', author: 'skill', message: 'tighten' });
    await store.decide(p.id, 'rejected');
    await store.addBackup('example.com', 'zone-id', '{"phases":{},"settings":{}}');
    await store.addRun([{ zone: 'example.com', state: 'in sync', changes: 0, error: null }]);
    const text = exportText(await store.exportData());

    const copy = openSqliteStore(join(dir, 'copy.sqlite'), { create: true });
    await copy.importData(parseExport(text));
    expect(exportText(await copy.exportData())).toBe(text);
    await expect(copy.importData(parseExport(text))).rejects.toThrow(/not empty/);
    copy.close();
    expect(Object.keys(JSON.parse(text))).toEqual(['flarewall_export', 'schema_version', 'revisions', 'backups', 'runs', 'run_zones']);
  });

  it('rejects a file that is not an export', () => {
    expect(() => parseExport('{')).toThrow(/not valid JSON/);
    expect(() => parseExport('{"flarewall_export": 1}')).toThrow(/not a flarewall export/);
  });
});
