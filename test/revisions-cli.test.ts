// The revision commands: edit, propose, log, show, revert, approve, reject, export, and import.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunDeps } from '../src/cli/run.js';
import { textDiff } from '../src/core/revisions.js';
import type { DataStore } from '../src/core/store.js';
import type { Editor } from '../src/node/edit.js';
import { isSqliteWarning } from '../src/node/warnings.js';
import { memoryStore, putBaseline, putInventory } from './helpers.js';

const ID = '023e105f4ecef8ad9ca31a8372d0c353';
const COM = `version: 1\nzone: example.com\nzone_id: "${ID}"\nhosts:\n  api: []\n  wordpress: []\nredirects: root\n`;
const COM_API = COM.replace('api: []', 'api: [api.example.com]');

let tick: number;
let store: DataStore;
let dir: string;
let stdin: string;

const cli = async (argv: string[], deps: RunDeps = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {}, { out: (l) => out.push(l), err: (l) => err.push(l) }, { store, readStdin: async () => stdin, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

/** An editor that replaces the file text with each answer in turn, and records what it was shown. */
function scriptedEditor(answers: string[], shown: string[] = []): Editor {
  return async (file) => {
    shown.push(readFileSync(file, 'utf8'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, answers.shift() ?? '');
  };
}

beforeEach(async () => {
  tick = 0;
  store = memoryStore(() => new Date(Date.UTC(2026, 9, 22, 9, 0, tick++)));
  await putBaseline(store);
  await putInventory(store, 'example.com', COM);
  dir = mkdtempSync(join(tmpdir(), 'flarewall-rev-'));
  stdin = '';
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('edit', () => {
  it('saves the edited text as an approved owner revision and prints the diff', async () => {
    const shown: string[] = [];
    const result = await cli(['edit', 'example.com', '-m', 'add the api host'], { editor: scriptedEditor([COM_API], shown) });
    expect(result.code).toBe(0);
    expect(shown).toEqual([COM]);
    expect(result.out).toContain('-   api: []\n+   api: [api.example.com]');
    expect(result.out).toContain('saved example.com inventory revision 3');
    expect(await store.current({ kind: 'inventory', zone: 'example.com' })).toMatchObject({ id: 3, parentId: 2, author: 'owner', message: 'add the api host', text: COM_API });
  });

  it('reopens an invalid file with the error at the top, then saves the fixed text', async () => {
    const shown: string[] = [];
    const result = await cli(['edit', 'example.com'], { editor: scriptedEditor(['version: 2\n', COM_API], shown) });
    expect(result.code).toBe(0);
    expect(shown[1]).toMatch(/^# flarewall: /);
    expect(shown[1]).toContain('version: 2');
    expect((await store.current({ kind: 'inventory', zone: 'example.com' }))?.text).toBe(COM_API);
  });

  it('refuses a text that names another zone', async () => {
    const shown: string[] = [];
    await cli(['edit', 'example.com'], { editor: scriptedEditor([COM.replace('zone: example.com', 'zone: example.net'), COM_API], shown) });
    expect(shown[1]).toContain('# flarewall: the inventory names zone example.net, not example.com');
  });

  it('saves nothing for an unchanged or emptied file', async () => {
    expect((await cli(['edit', 'example.com'], { editor: scriptedEditor([COM]) })).out).toBe('example.com: no change; nothing saved');
    expect((await cli(['edit', '--baseline'], { editor: scriptedEditor(['']) })).out).toBe('baseline: the file was emptied; nothing saved');
    expect(await store.listRevisions()).toHaveLength(2);
  });

  it('refuses a zone with no inventory', async () => {
    const result = await cli(['edit', 'example.net'], { editor: scriptedEditor([COM]) });
    expect(result.code).toBe(2);
    expect(result.err).toBe('run flarewall add example.net first');
  });
});

describe('propose, approve, and reject', () => {
  it('writes a pending revision from a file, by skill, and approve makes it current', async () => {
    const file = join(dir, 'com.yaml');
    writeFileSync(file, COM_API);
    const proposed = await cli(['propose', 'example.com', file, '--message', 'api host']);
    expect(proposed).toEqual({ code: 0, out: 'pending revision 3', err: '' });
    expect(await store.getRevision(3)).toMatchObject({ status: 'pending', author: 'skill', parentId: 2, message: 'api host' });
    expect((await store.current({ kind: 'inventory', zone: 'example.com' }))?.id).toBe(2);

    expect((await cli(['approve', '3'])).out).toBe('approved revision 3 (example.com inventory)');
    expect((await store.current({ kind: 'inventory', zone: 'example.com' }))?.id).toBe(3);
  });

  it('reads stdin for -, takes --author, and proposes the baseline', async () => {
    stdin = readFileSync(new URL('../src/baseline/default.yaml', import.meta.url), 'utf8').replace('version: 1', 'version: 1\n# tuned');
    expect((await cli(['propose', '--baseline', '-', '--author', 'claude'])).out).toBe('pending revision 3');
    expect(await store.getRevision(3)).toMatchObject({ kind: 'baseline', zone: null, author: 'claude' });
    expect((await cli(['reject', '#3'])).out).toBe('rejected revision 3 (baseline)');
    expect((await cli(['approve', '3'])).err).toBe('revision 3 is rejected, not pending');
  });

  it('refuses a zone with no inventory, an invalid text, and no change', async () => {
    stdin = COM;
    expect((await cli(['propose', 'example.net', '-'])).err).toBe('run flarewall add example.net first');
    expect((await cli(['propose', 'example.com', '-'])).err).toBe('example.com: no change');
    stdin = 'version: 2\n';
    expect((await cli(['propose', 'example.com', '-'])).err).toMatch(/^example\.com: /);
    expect(await store.listRevisions()).toHaveLength(2);
  });

  it('an owner edit makes a pending revision stale, says so, and approve refuses it', async () => {
    stdin = COM_API;
    await cli(['propose', 'example.com', '-']);
    const edit = await cli(['edit', 'example.com'], { editor: scriptedEditor([COM.replace('redirects: root', 'redirects: www')]) });
    expect(edit.out).toContain('pending revisions now stale (approval will refuse them): #3');
    const approve = await cli(['approve', '3']);
    expect(approve.code).toBe(2);
    expect(approve.err).toBe('revision 3 is based on 2, but the current revision is 4; propose it again');
  });
});

describe('log, show, and revert', () => {
  it('log lists every revision oldest first, or one zone', async () => {
    stdin = COM_API;
    await cli(['propose', 'example.com', '-', '-m', 'api host']);
    const log = await cli(['log']);
    expect(log.out.split('\n')).toEqual([
      '#1  2026-10-22T09:00:00.000Z  baseline  approved  owner',
      '#2  2026-10-22T09:00:01.000Z  example.com inventory  approved  owner',
      '#3  2026-10-22T09:00:02.000Z  example.com inventory  pending  skill  api host',
    ]);
    expect((await cli(['log', 'example.com'])).out.split('\n')).toHaveLength(2);
    expect((await cli(['log', 'example.net'])).out).toBe('no revisions');
  });

  it('show prints a comment header and the text', async () => {
    const show = await cli(['show', '2']);
    expect(show.out.split('\n').slice(0, 2)).toEqual([
      '# revision 2: example.com inventory, approved, by owner, 2026-10-22T09:00:01.000Z',
      expect.stringMatching(/^# parent none, sha256 [0-9a-f]{64}$/),
    ]);
    expect(show.out).toContain(COM.trimEnd());
    expect((await cli(['show', '9'])).err).toBe('no revision 9');
  });

  it('revert saves the older text as a new revision and deletes nothing', async () => {
    await cli(['edit', 'example.com'], { editor: scriptedEditor([COM_API]) });
    const revert = await cli(['revert', '2']);
    expect(revert.out).toBe('saved example.com inventory revision 4');
    expect(await store.getRevision(4)).toMatchObject({ text: COM, parentId: 3, message: 'revert to 2', author: 'owner' });
    expect((await cli(['log', 'example.com'])).out.split('\n')).toHaveLength(3);
    expect((await cli(['revert', '4'])).err).toBe('example.com: no change');
  });

  it('revert refuses a pending revision', async () => {
    stdin = COM_API;
    await cli(['propose', 'example.com', '-']);
    expect((await cli(['revert', '3'])).err).toBe('revision 3 is pending; only an approved revision can be restored');
  });
});

describe('export and import', () => {
  it('export then import into a new file gives a byte-identical export', async () => {
    stdin = COM_API;
    await cli(['propose', 'example.com', '-']);
    await store.addBackup('example.com', ID, '{"phases":{},"settings":{"always_use_https":"off"}}');
    await store.addRun([{ zone: 'example.com', state: 'drift', changes: 1, error: null }]);
    const first = join(dir, 'first.json');
    expect((await cli(['export', first])).code).toBe(0);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect((await cli(['export', first])).err).toBe(`${first} already exists; flarewall export does not overwrite it`);

    const db = join(dir, 'copy.sqlite');
    const imported = await run(['import', first], { FLAREWALL_DB: db }, { out: () => {}, err: () => {} });
    expect(imported).toBe(0);
    const second = join(dir, 'second.json');
    expect(await run(['export', second], { FLAREWALL_DB: db }, { out: () => {}, err: () => {} })).toBe(0);
    expect(readFileSync(second, 'utf8')).toBe(readFileSync(first, 'utf8'));

    const err: string[] = [];
    expect(await run(['import', first], { FLAREWALL_DB: db }, { out: () => {}, err: (l) => err.push(l) })).toBe(2);
    expect(err).toEqual([`${db} is not empty; flarewall import loads into an empty database only`]);
  });
});

describe('helpers', () => {
  it('textDiff marks removed and added lines with one line of context', () => {
    expect(textDiff('a\nb\nc\nd\ne\nf\n', 'a\nb\nc\nX\ne\nf\n')).toEqual(['  ...', '  c', '- d', '+ X', '  e', '  ...']);
  });

  it('isSqliteWarning matches only the node:sqlite ExperimentalWarning', () => {
    expect(isSqliteWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')).toBe(true);
    expect(isSqliteWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' })).toBe(true);
    expect(isSqliteWarning('VM Modules is an experimental feature', 'ExperimentalWarning')).toBe(false);
    expect(isSqliteWarning('SQLite something', 'DeprecationWarning')).toBe(false);
  });
});
