// Frame tests for the read-only TUI: the screen on the fake client and a temp data dir.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffLines, statusLines } from '../src/cli/format.js';
import { render as renderZone } from '../src/core/render.js';
import { parseInventory } from '../src/core/schema.js';
import { statusAll } from '../src/core/status.js';
import { loadData } from '../src/node/data.js';
import { createTui } from '../src/tui/main.js';
import { FakeCloudflareApi, liveFromDesired } from './fake-api.js';
import { DEFAULT_BASELINE_FILE, defaultBaseline, legacyCase } from './helpers.js';

const ACCOUNT = '01a7362d577a6c3019a474fd6f485823';
const IDS = {
  bad: '0000000000000000000000000000abcd',
  com: '023e105f4ecef8ad9ca31a8372d0c353',
  net: '0123456789abcdef0123456789abcdef',
  org: '1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
  new: '2b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
};
const PLAN = 'Free Website';

const inventoryText = (zone: string, id: string, extra = 'redirects: root\n') => `version: 1\nzone: ${zone}\nzone_id: "${id}"\n${extra}`;
const NET_EXTRA = 'hosts:\n  api: [api.example.net]\n  wordpress: [blog.example.net]\ngeo:\n  enabled: true\n  country: XX\nredirects: www\n';
const NET_DNS = [
  { name: 'api.example.net', type: 'A', content: '192.0.2.10', proxied: true },
  { name: 'blog.example.net', type: 'A', content: '198.51.100.7', proxied: true },
];

/** A fake whose DNS reads wait until `release` is called, so a frame can be taken before any report. */
class GatedApi extends FakeCloudflareApi {
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  release(): void {
    this.open();
  }
  override async listDnsRecords(zoneId: string) {
    await this.gate;
    return super.listDnsRecords(zoneId);
  }
}

let dir: string;

function writeInventory(name: string, text: string) {
  mkdirSync(join(dir, 'inventory', ACCOUNT), { recursive: true });
  writeFileSync(join(dir, 'inventory', ACCOUNT, `${name}.yaml`), text);
}

/**
 * Five zones, sorted: bad.example.com (error), example.com (legacy), example.net (in sync),
 * example.org (drift), new.example.com (not managed).
 */
function seed(api: FakeCloudflareApi) {
  const legacy = legacyCase('no-hosts-www');
  writeInventory('example.com', readFileSync(join(import.meta.dirname, 'fixtures/legacy-script/no-hosts-www/inventory.yaml'), 'utf8'));
  api.addZone({
    summary: { id: IDS.com, name: 'example.com', accountId: ACCOUNT, plan: PLAN },
    dns: legacy.dns,
    phases: {
      http_request_firewall_custom: legacy.phase('http_request_firewall_custom'),
      http_ratelimit: legacy.phase('http_ratelimit'),
      http_request_dynamic_redirect: legacy.phase('http_request_dynamic_redirect'),
    },
    settings: { always_use_https: 'on', browser_check: 'on' },
    botManagement: { fight_mode: true, enable_js: true },
  });

  const net = inventoryText('example.net', IDS.net, NET_EXTRA);
  writeInventory('example.net', net);
  api.addZone({
    summary: { id: IDS.net, name: 'example.net', accountId: ACCOUNT, plan: PLAN },
    dns: NET_DNS,
    ...liveFromDesired(renderZone(defaultBaseline(), parseInventory(net), NET_DNS)),
  });

  const org = inventoryText('example.org', IDS.org);
  writeInventory('example.org', org);
  const orgZone = api.addZone({
    summary: { id: IDS.org, name: 'example.org', accountId: ACCOUNT, plan: 'Pro Website' },
    ...liveFromDesired(renderZone(defaultBaseline(), parseInventory(org), [])),
  });
  orgZone.settings.always_use_https = 'off';

  writeInventory('bad.example.com', inventoryText('bad.example.com', IDS.bad));
  api.addZone({ summary: { id: IDS.bad, name: 'bad.example.com', accountId: ACCOUNT, plan: PLAN } });
  api.fail('getPhase', IDS.bad, 'getPhase failed: 403 forbidden');

  api.addZone({ summary: { id: IDS.new, name: 'new.example.com', accountId: ACCOUNT, plan: PLAN } });
}

const ZONES = ['bad.example.com', 'example.com', 'example.net', 'example.org', 'new.example.com'];
const INVENTORY_ZONES = ZONES.filter((z) => z !== 'new.example.com');

function start(api: FakeCloudflareApi) {
  const onQuit = vi.fn();
  const { element } = createTui({ api, dataDir: dir, load: loadData, columns: 100, rows: 40, onQuit });
  const screen = render(element);
  return { ...screen, onQuit, frame: () => screen.lastFrame() ?? '' };
}

/** Sets the fake terminal width and tells the app, as a terminal resize does. */
function resize(stdout: { emit: (event: string) => boolean }, columns: number) {
  Object.defineProperty(stdout, 'columns', { configurable: true, get: () => columns });
  stdout.emit('resize');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The frame line of a zone row: the border, the padding, the selection marker, then the zone name. */
function rowLine(frame: string, zone: string): string | undefined {
  const pattern = new RegExp(`^│ (> |  )${escape(zone)}\\s`);
  return frame.split('\n').find((l) => pattern.test(l));
}

/** The diff pane column of a two-pane frame: each line from the second top-border corner on. */
function diffColumn(frame: string): string {
  const lines = frame.split('\n');
  const top = lines.find((l) => l.indexOf('╭') !== l.lastIndexOf('╭')) ?? '';
  const at = top.lastIndexOf('╭');
  return lines.map((l) => l.slice(at)).join('\n');
}

/** The frame text without borders, with each run of white space as one space. */
const flat = (text: string) => text.replace(/[│┌┐└┘╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');

async function loadedScreen(api: FakeCloudflareApi) {
  const screen = start(api);
  await vi.waitFor(() => {
    for (const zone of ZONES) expect(rowLine(screen.frame(), zone)).not.toMatch(/loading/);
    expect(rowLine(screen.frame(), 'new.example.com')).toBeDefined();
  });
  return screen;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flarewall-tui-'));
  copyFileSync(DEFAULT_BASELINE_FILE, join(dir, 'baseline.yaml'));
});
afterEach(() => {
  cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('TUI frames', () => {
  it('shows every inventory zone with the state word that statusLines prints', async () => {
    const api = new FakeCloudflareApi();
    seed(api);
    const { baseline, inventories } = await loadData(dir);
    const words = new Map(
      statusLines(await statusAll(api, baseline, inventories))
        .slice(1)
        .map((line) => {
          const [zone, , state] = line.split(/\s{2,}/);
          return [zone ?? '', (state ?? '').split(':')[0] ?? ''] as const;
        }),
    );
    expect([...words.keys()]).toEqual(ZONES);
    expect(new Set(words.values())).toEqual(new Set(['error', 'legacy', 'in sync', 'drift', 'not managed']));

    const screen = await loadedScreen(api);
    for (const [zone, word] of words) {
      expect(rowLine(screen.frame(), zone), zone).toMatch(new RegExp(`\\s${word}\\s`));
    }
  });

  it('shows every row with loading in STATE before the first report arrives', async () => {
    const api = new GatedApi();
    seed(api);
    const screen = start(api);
    await vi.waitFor(() => {
      for (const zone of INVENTORY_ZONES) expect(rowLine(screen.frame(), zone), zone).toBeDefined();
    });
    const frame = screen.frame();
    expect(frame).toMatch(/ZONE ↓\s+PLAN ?\s+STATE\s+CHANGES\s+UNOWNED\s+HOSTS\s+GEO\s+REDIRECT/);
    for (const zone of INVENTORY_ZONES) expect(rowLine(frame, zone), zone).toMatch(/\sloading\s/);
    // The inventory columns draw at once: example.net has two hosts, geo XX, and www redirects.
    expect(rowLine(frame, 'example.net')).toMatch(/loading\s+-\s+-\s+2\s+XX\s+www/);
    api.release();
    await vi.waitFor(() => expect(rowLine(screen.frame(), 'example.net')).toMatch(/\sin sync\s/));
  });

  it("after j, the diff pane shows the second zone's diffLines", async () => {
    const api = new FakeCloudflareApi();
    seed(api);
    const { baseline, inventories } = await loadData(dir);
    const second = (await statusAll(api, baseline, inventories, ['example.com']))[0];
    if (second === undefined) throw new Error('no report for example.com');
    // The pane title carries `example.com ◆ legacy`, so the pane drops the head line that repeats it.
    const want = flat(diffLines([second]).slice(1).join('\n'));

    const screen = await loadedScreen(api);
    resize(screen.stdout, 400);
    await vi.waitFor(() => expect(screen.frame()).toContain('bad.example.com ✗ error'));
    expect(flat(diffColumn(screen.frame()))).not.toContain(want);
    screen.stdin.write('j');
    await vi.waitFor(() => expect(flat(diffColumn(screen.frame()))).toContain(want));
    expect(rowLine(screen.frame(), 'example.com')).toMatch(/>\s+example\.com/);
  });

  it('shows one pane at 100 columns, and tab switches to the other', async () => {
    const api = new FakeCloudflareApi();
    seed(api);
    const screen = await loadedScreen(api);
    const zonesOnly = screen.frame();
    expect(zonesOnly).toMatch(/ZONE ↓\s+PLAN\s+STATE/);
    expect(zonesOnly).toContain('1/2');
    expect(zonesOnly).not.toContain('bad.example.com: error: getPhase failed');

    screen.stdin.write('\t');
    await vi.waitFor(() => expect(screen.frame()).toContain('2/2'));
    const diffOnly = screen.frame();
    expect(diffOnly).toContain('bad.example.com: error: getPhase failed: 403 forbidden');
    expect(diffOnly).not.toMatch(/ZONE ↓\s+PLAN\s+STATE/);

    screen.stdin.write('\t');
    await vi.waitFor(() => expect(screen.frame()).toContain('1/2'));
    expect(screen.frame()).toMatch(/ZONE ↓\s+PLAN\s+STATE/);

    resize(screen.stdout, 400);
    await vi.waitFor(() => expect(screen.frame()).not.toContain('1/2'));
    expect(screen.frame()).toMatch(/ZONE ↓\s+PLAN\s+STATE/);
    expect(screen.frame()).toContain('bad.example.com: error: getPhase failed: 403 forbidden');
  });

  it('R after a bad edit to baseline.yaml shows the parse error in the header and keeps the earlier rows', async () => {
    const api = new FakeCloudflareApi();
    seed(api);
    const screen = await loadedScreen(api);
    const before = ZONES.map((z) => rowLine(screen.frame(), z));

    writeFileSync(join(dir, 'baseline.yaml'), 'version: 2\n');
    screen.stdin.write('R');
    await vi.waitFor(() => expect(screen.frame()).toContain('baseline.yaml: invalid baseline'));
    const header = screen.frame().split('\n').slice(0, 2).join('\n');
    expect(header).toContain(`${join(dir, 'baseline.yaml')}: invalid baseline`);
    expect(ZONES.map((z) => rowLine(screen.frame(), z))).toEqual(before);
  });

  it('R after a YAML syntax error in baseline.yaml names the file in the header', async () => {
    const api = new FakeCloudflareApi();
    seed(api);
    const screen = await loadedScreen(api);
    writeFileSync(join(dir, 'baseline.yaml'), 'version: [1\n');
    screen.stdin.write('R');
    await vi.waitFor(() => expect(screen.frame()).toContain(`${join(dir, 'baseline.yaml')}: `));
    expect(rowLine(screen.frame(), 'example.org')).toMatch(/\sdrift\s/);
  });

  it('q quits', async () => {
    const api = new FakeCloudflareApi();
    seed(api);
    const screen = await loadedScreen(api);
    screen.stdin.write('q');
    await vi.waitFor(() => expect(screen.onQuit).toHaveBeenCalledTimes(1));
  });
});
