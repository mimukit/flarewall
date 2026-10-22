// init, the database file location, and the --data removal.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { openSqliteStore } from '../src/node/sqlite-store.js';
import { DEFAULT_BASELINE_FILE } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('flarewall init', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flarewall-init-'));
    db = join(dir, 'data', 'flarewall.sqlite');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file at FLAREWALL_DB, writes the default baseline as revision 1, and prints its id', async () => {
    const c = capture();
    expect(await run(['init'], { FLAREWALL_DB: db }, c.io)).toBe(0);
    expect(c.out).toEqual([`baseline revision 1 written to ${db}`]);
    expect(statSync(db).mode & 0o777).toBe(0o600);
    const store = openSqliteStore(db);
    try {
      expect(await store.current({ kind: 'baseline', zone: null })).toMatchObject({
        id: 1,
        status: 'approved',
        author: 'owner',
        message: 'flarewall init',
        text: readFileSync(DEFAULT_BASELINE_FILE, 'utf8'),
      });
    } finally {
      store.close();
    }
  });

  it('uses XDG_DATA_HOME when FLAREWALL_DB is not set', async () => {
    expect(await run(['init'], { XDG_DATA_HOME: dir }, capture().io)).toBe(0);
    expect(statSync(join(dir, 'flarewall', 'flarewall.sqlite')).isFile()).toBe(true);
  });

  it('refuses to init a database that holds a baseline', async () => {
    expect(await run(['init'], { FLAREWALL_DB: db }, capture().io)).toBe(0);
    const c = capture();
    expect(await run(['init'], { FLAREWALL_DB: db }, c.io)).toBe(2);
    expect(c.err).toEqual([`the database at ${db} already holds a baseline; flarewall init does not overwrite it`]);
  });

  it('every other command stops when the file is missing', async () => {
    for (const argv of [['log'], ['status'], ['show', '1'], ['backups', 'example.com']]) {
      const c = capture();
      expect(await run(argv, { FLAREWALL_DB: db, CLOUDFLARE_API_TOKEN: 'test-token' }, c.io)).toBe(2);
      expect(c.err).toEqual([`no flarewall database at ${db}; run flarewall init`]);
    }
  });

  it('--data and FLAREWALL_DATA stop the command and name FLAREWALL_DB', async () => {
    for (const [argv, env] of [
      [['init', '--data', dir], {}],
      [['status'], { FLAREWALL_DATA: dir }],
    ] as const) {
      const c = capture();
      expect(await run([...argv], { ...env, FLAREWALL_DB: db }, c.io)).toBe(2);
      expect(c.err).toEqual(['--data is gone; flarewall reads FLAREWALL_DB']);
    }
  });

  it('rejects an unknown command', async () => {
    expect(await run(['nope'], { FLAREWALL_DB: db }, capture().io)).toBe(2);
  });
});
