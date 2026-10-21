// Frame tests for the TUI dry run and write path: the screen on the fake client and a temp data dir.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planLines } from '../src/cli/format.js';
import { run } from '../src/cli/run.js';
import type { LiveRule } from '../src/core/api.js';
import { applyInventoryZone, type ZonePlan } from '../src/core/apply.js';
import { render as renderZone, type Phase } from '../src/core/render.js';
import { parseInventory } from '../src/core/schema.js';
import { loadData } from '../src/node/data.js';
import { createTui } from '../src/tui/main.js';
import { tuiExitCode } from '../src/tui/state.js';
import { FakeCloudflareApi, liveFromDesired, type FakeZone } from './fake-api.js';
import { DEFAULT_BASELINE_FILE, defaultBaseline, legacyCase } from './helpers.js';

const ACCOUNT = '01a7362d577a6c3019a474fd6f485823';
const IDS = {
  com: '023e105f4ecef8ad9ca31a8372d0c353',
  net: '0123456789abcdef0123456789abcdef',
  org: '1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
};
const PLAN = 'Free Website';
const NOW = new Date('2026-10-21T08:15:00Z');
const STAMP = '20261021T081500Z';
const ORG = `version: 1\nzone: example.org\nzone_id: "${IDS.org}"\nredirects: root\n`;
const NET = `version: 1\nzone: example.net\nzone_id: "${IDS.net}"\nredirects: root\n`;

let dirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flarewall-tui-write-'));
  copyFileSync(DEFAULT_BASELINE_FILE, join(dir, 'baseline.yaml'));
  dirs.push(dir);
  return dir;
}

function writeInventory(dir: string, name: string, text: string) {
  mkdirSync(join(dir, 'inventory', ACCOUNT), { recursive: true });
  writeFileSync(join(dir, 'inventory', ACCOUNT, `${name}.yaml`), text);
}

/** Three zones, sorted: example.com (legacy), example.net (in sync), example.org (drift). */
function seed(api: FakeCloudflareApi, dir: string): { com: FakeZone; org: FakeZone } {
  const legacy = legacyCase('no-hosts-www');
  writeInventory(dir, 'example.com', readFileSync(join(import.meta.dirname, 'fixtures/legacy-script/no-hosts-www/inventory.yaml'), 'utf8'));
  const withIds = (phase: Phase): LiveRule[] => legacy.phase(phase).map((r, i) => ({ id: `legacy-${phase}-${i}`, ...r }));
  const com = api.addZone({
    summary: { id: IDS.com, name: 'example.com', accountId: ACCOUNT, plan: PLAN },
    dns: legacy.dns,
    phases: {
      http_request_firewall_custom: withIds('http_request_firewall_custom'),
      http_ratelimit: withIds('http_ratelimit'),
      http_request_dynamic_redirect: withIds('http_request_dynamic_redirect'),
    },
    settings: { always_use_https: 'off', browser_check: 'on' },
    botManagement: { fight_mode: false, enable_js: false },
  });

  writeInventory(dir, 'example.net', NET);
  api.addZone({ summary: { id: IDS.net, name: 'example.net', accountId: ACCOUNT, plan: PLAN }, ...liveFromDesired(renderZone(defaultBaseline(), parseInventory(NET), [])) });

  writeInventory(dir, 'example.org', ORG);
  const org = api.addZone({ summary: { id: IDS.org, name: 'example.org', accountId: ACCOUNT, plan: PLAN }, ...liveFromDesired(renderZone(defaultBaseline(), parseInventory(ORG), [])) });
  org.settings.always_use_https = 'off';
  return { com, org };
}

function start(api: FakeCloudflareApi, dir: string) {
  const onQuit = vi.fn();
  const { store, element } = createTui({ api, dataDir: dir, columns: 400, rows: 60, now: () => NOW, onQuit });
  const screen = render(element);
  // A fake stdout has 100 columns; set 400, as a terminal resize does, so both panes show.
  Object.defineProperty(screen.stdout, 'columns', { configurable: true, get: () => 400 });
  screen.stdout.emit('resize');
  return { ...screen, store, onQuit, frame: () => screen.lastFrame() ?? '' };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The frame line of a zone row: the border, the selection and mark markers, then the zone name. */
function rowLine(frame: string, zone: string): string | undefined {
  const pattern = new RegExp(`^│ [> ][● ]${escape(zone)}\\s`);
  return frame.split('\n').find((l) => pattern.test(l));
}

/** The frame text without borders, with each run of white space as one space. */
const flat = (text: string) => text.replace(/[│┌┐└┘╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');

/** The diff pane column of a two-pane frame: each line from the second top-border corner on. */
function diffColumn(frame: string): string {
  const lines = frame.split('\n');
  const top = lines.find((l) => l.indexOf('╭') !== l.lastIndexOf('╭')) ?? '';
  const at = top.lastIndexOf('╭');
  return lines.map((l) => l.slice(at)).join('\n');
}

const ZONES = ['example.com', 'example.net', 'example.org'];

async function loadedScreen(api: FakeCloudflareApi, dir: string) {
  const screen = start(api, dir);
  await vi.waitFor(() => {
    for (const zone of ZONES) expect(rowLine(screen.frame(), zone)).toMatch(/\s(legacy|in sync|drift)\s/);
  });
  return screen;
}

/** Writes keys one at a time, each after the frame settles, as a person types. */
async function keys(screen: { stdin: { write: (s: string) => void } }, ...list: string[]) {
  for (const k of list) {
    screen.stdin.write(k);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const prompt = (zone: string) => `Apply the baseline to ${zone}? [y/N]`;
const ESC = '\u001b';
const CTRL_C = '\u0003';

/** Every backup file under <dir>/backups/<zone>, as relative path -> content. */
function backupFiles(dir: string, zone: string): Record<string, string> {
  const root = join(dir, 'backups', zone);
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const stamp of readdirSync(root)) {
    for (const file of readdirSync(join(root, stamp))) out[`${stamp}/${file}`] = readFileSync(join(root, stamp, file), 'utf8');
  }
  return out;
}

beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('TUI add', () => {
  it('+ writes the inventory entry of a not managed zone, then reloads it as a managed zone', async () => {
    const dir = dataDir();
    const api = new FakeCloudflareApi();
    seed(api, dir);
    api.addZone({
      summary: { id: '2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f', name: 'example.edu', accountId: ACCOUNT, plan: PLAN },
      dns: [{ type: 'A', name: 'www.example.edu', content: '192.0.2.10', proxied: true }],
    });
    const screen = await loadedScreen(api, dir);
    await vi.waitFor(() => expect(rowLine(screen.frame(), 'example.edu')).toMatch(/not managed/));
    // The list sorts by name: example.com, then example.edu.
    await keys(screen, 'g', 'g', 'j');
    expect(flat(screen.frame())).toContain('Press + to add it');
    await keys(screen, '+');
    const path = join(dir, 'inventory', ACCOUNT, 'example.edu.yaml');
    await vi.waitFor(() => expect(rowLine(screen.frame(), 'example.edu')).not.toMatch(/not managed|loading/));
    expect(readFileSync(path, 'utf8')).toContain('#   www.example.edu');
    expect(flat(diffColumn(screen.frame()))).toContain(`example.edu: wrote ${path}`);
  });
});

describe('TUI dry run and write', () => {
  it('d sends no write call and the diff pane shows the planLines text', async () => {
    const dir = dataDir();
    const api = new FakeCloudflareApi();
    seed(api, dir);
    const { baseline, inventories } = await loadData(dir);
    let plan: ZonePlan | undefined;
    const inventory = inventories.find((i) => i.zone === 'example.org');
    if (inventory === undefined) throw new Error('no example.org inventory');
    await applyInventoryZone(api, baseline, inventory, { backup: async () => 'unused', onPlan: (p) => (plan = p) });
    if (plan === undefined) throw new Error('no plan');
    const want = flat(planLines(plan).join('\n'));
    expect(want).toContain('always_use_https');

    const screen = await loadedScreen(api, dir);
    await keys(screen, 'j', 'j', 'd');
    await vi.waitFor(() => expect(flat(diffColumn(screen.frame()))).toContain(want));
    await vi.waitFor(() => expect(screen.frame()).toContain('example.org: dry run, nothing sent'));
    expect(api.writes).toEqual([]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('a then y writes the same backup files as flarewall apply --write, and the zone then shows in sync', async () => {
    const cliDir = dataDir();
    const cliApi = new FakeCloudflareApi();
    seed(cliApi, cliDir);
    const code = await run(['apply', 'example.com', '--write', '--yes'], { CLOUDFLARE_API_TOKEN: 'test-token', FLAREWALL_DATA: cliDir }, { out: () => {}, err: () => {} }, { api: () => cliApi, now: () => NOW });
    expect(code).toBe(0);
    const want = backupFiles(cliDir, 'example.com');
    expect(Object.keys(want).length).toBeGreaterThan(0);

    const dir = dataDir();
    const api = new FakeCloudflareApi();
    seed(api, dir);
    const screen = await loadedScreen(api, dir);
    await keys(screen, 'a');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.com')));
    expect(screen.frame()).toContain('example.com plan (1 of 1)');
    // CONFIRM shows the y/N keys in the hint line.
    expect(screen.frame()).toContain('y apply this zone');
    expect(api.writes).toEqual([]);
    await keys(screen, 'y');
    await vi.waitFor(() => expect(screen.frame()).toContain('example.com: applied, read-back in sync'));
    await vi.waitFor(() => expect(rowLine(screen.frame(), 'example.com')).toMatch(/\sin sync\s/));
    expect(flat(screen.frame())).toContain(`example.com: backup written to ${join(dir, 'backups', 'example.com', STAMP)}`);
    expect(backupFiles(dir, 'example.com')).toEqual(want);
    expect(Object.keys(want).every((f) => f.startsWith(`${STAMP}/`))).toBe(true);
  });

  it('a then n sends no write call', async () => {
    const dir = dataDir();
    const api = new FakeCloudflareApi();
    seed(api, dir);
    const screen = await loadedScreen(api, dir);
    await keys(screen, 'a');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.com')));
    await keys(screen, 'n');
    await vi.waitFor(() => expect(screen.frame()).toContain('example.com: declined, nothing sent'));
    expect(api.writes).toEqual([]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('with two marked zones, a, y, esc writes the first zone only', async () => {
    const dir = dataDir();
    const api = new FakeCloudflareApi();
    seed(api, dir);
    const screen = await loadedScreen(api, dir);
    await keys(screen, ' ', 'j', 'j', ' ');
    await vi.waitFor(() => expect(rowLine(screen.frame(), 'example.org')).toMatch(/^│ >●/));
    expect(rowLine(screen.frame(), 'example.com')).toMatch(/^│  ●/);
    expect(screen.frame()).toContain('2 marked');
    await keys(screen, 'a');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.com')));
    expect(screen.frame()).toContain('example.com plan (1 of 2)');
    await keys(screen, 'y');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.org')));
    expect(screen.frame()).toContain('example.org plan (2 of 2)');
    await keys(screen, ESC);
    await vi.waitFor(() => expect(screen.frame()).toContain('example.org: declined, nothing sent'));
    await vi.waitFor(() => expect(screen.frame()).toContain('q quit'));
    expect(api.writes.length).toBeGreaterThan(0);
    expect(api.writes.every((w) => w.zoneId === IDS.com)).toBe(true);
  });

  it('with one of two marked zones hidden by a filter, a opens CONFIRM for the visible zone only', async () => {
    const dir = dataDir();
    const api = new FakeCloudflareApi();
    seed(api, dir);
    const screen = await loadedScreen(api, dir);
    await keys(screen, ' ', 'j', 'j', ' ', '/', 'o', 'r', 'g', '\r');
    await vi.waitFor(() => expect(screen.frame()).toContain('2 marked, 1 hidden'));
    expect(rowLine(screen.frame(), 'example.com')).toBeUndefined();
    await keys(screen, 'a');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.org')));
    expect(screen.frame()).toContain('example.org plan (1 of 1)');
    await keys(screen, 'n');
    await vi.waitFor(() => expect(screen.frame()).toContain('q quit'));
    expect(screen.frame()).not.toContain(prompt('example.com'));
    expect(api.writes).toEqual([]);
  });

  it('with a fake that rejects updatePhase, a then y shows the error and the backup path, and the zone keeps its rules', async () => {
    const dir = dataDir();
    const api = new FakeCloudflareApi();
    const { com } = seed(api, dir);
    const before = structuredClone(com.phases);
    api.fail('updatePhase', IDS.com, 'updatePhase failed: 403 forbidden');
    const screen = await loadedScreen(api, dir);
    await keys(screen, 'a');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.com')));
    await keys(screen, 'y');
    await vi.waitFor(() => expect(screen.frame()).toContain('example.com: error: updatePhase failed: 403 forbidden'));
    expect(flat(screen.frame())).toContain(`example.com: backup written to ${join(dir, 'backups', 'example.com', STAMP)}`);
    expect(rowLine(screen.frame(), 'example.com')).toMatch(/\serror\s/);
    expect(com.phases).toEqual(before);
    expect(tuiExitCode(screen.store.getState())).toBe(2);
  });

  it('ctrl-c during a write lets the read-back finish before the TUI quits', async () => {
    const log: string[] = [];
    class SlowWriteApi extends FakeCloudflareApi {
      private open!: () => void;
      private readonly gate = new Promise<void>((resolve) => {
        this.open = resolve;
      });
      release(): void {
        this.open();
      }
      override async getPhase(zoneId: string, phase: Phase) {
        log.push(`getPhase ${zoneId}`);
        return super.getPhase(zoneId, phase);
      }
      override async updatePhase(zoneId: string, phase: Phase, rules: LiveRule[]) {
        log.push('updatePhase start');
        await this.gate;
        log.push('updatePhase end');
        return super.updatePhase(zoneId, phase, rules);
      }
    }
    const dir = dataDir();
    const api = new SlowWriteApi();
    seed(api, dir);
    const screen = await loadedScreen(api, dir);
    screen.onQuit.mockImplementation(() => log.push('quit'));
    await keys(screen, ' ', 'j', 'j', ' ', 'a');
    await vi.waitFor(() => expect(screen.frame()).toContain(prompt('example.com')));
    await keys(screen, 'y');
    await vi.waitFor(() => expect(log).toContain('updatePhase start'));
    await keys(screen, CTRL_C);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.onQuit).not.toHaveBeenCalled();
    api.release();
    await vi.waitFor(() => expect(screen.onQuit).toHaveBeenCalledTimes(1));
    const quitAt = log.indexOf('quit');
    const lastWrite = log.lastIndexOf('updatePhase end');
    const readBack = log.slice(lastWrite + 1, quitAt).filter((l) => l === `getPhase ${IDS.com}`);
    expect(readBack.length).toBeGreaterThanOrEqual(3);
    expect(api.writes.every((w) => w.zoneId === IDS.com)).toBe(true);
    expect(screen.frame()).not.toContain(prompt('example.org'));
    expect(tuiExitCode(screen.store.getState())).toBe(0);
  });
});
