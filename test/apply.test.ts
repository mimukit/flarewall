// C11 to C15: apply and restore, driven through the CLI with an in-memory CloudflareApi.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunDeps } from '../src/cli/run.js';
import type { LiveRule } from '../src/core/api.js';
import { applyInventoryZone, planZone } from '../src/core/apply.js';
import { render, type Phase } from '../src/core/render.js';
import { parseInventory } from '../src/core/schema.js';
import { FakeCloudflareApi, liveFromDesired } from './fake-api.js';
import { DEFAULT_BASELINE_FILE, defaultBaseline, legacyCase, readFixture } from './helpers.js';

const ACCOUNT = '01a7362d577a6c3019a474fd6f485823';
const IDS = {
  com: '023e105f4ecef8ad9ca31a8372d0c353',
  net: '0123456789abcdef0123456789abcdef',
  org: '1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
};
const CUSTOM: Phase = 'http_request_firewall_custom';
const RATE: Phase = 'http_ratelimit';
const REDIRECT: Phase = 'http_request_dynamic_redirect';
const LEGACY_CASE = 'api-wordpress-geo-root';
const NOW = new Date('2026-10-21T08:15:00Z');
const STAMP = '20261021T081500Z';

const NET_INVENTORY = `version: 1
zone: example.net
zone_id: "${IDS.net}"
hosts:
  api: [api.example.net]
  wordpress: []
geo:
  enabled: true
  country: XX
redirects: root
`;
const ORG_INVENTORY = `version: 1
zone: example.org
zone_id: "${IDS.org}"
hosts:
  api: []
  wordpress: []
redirects: www
`;

let dir: string;
let api: FakeCloudflareApi;
let answers: boolean[];
let asked: string[];
let isTTY: boolean;

const cli = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: RunDeps = {
    api: () => api,
    isTTY,
    now: () => NOW,
    confirm: async (question) => {
      asked.push(question);
      return answers.shift() ?? false;
    },
  };
  const code = await run(argv, { CLOUDFLARE_API_TOKEN: 'test-token', FLAREWALL_DATA: dir }, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
};

function writeInventory(name: string, text: string) {
  mkdirSync(join(dir, 'inventory', ACCOUNT), { recursive: true });
  writeFileSync(join(dir, 'inventory', ACCOUNT, `${name}.yaml`), text);
}

/** Gives every fixture rule an id, as Cloudflare does. */
function withIds(phase: Phase, rules: Record<string, unknown>[]): LiveRule[] {
  return rules.map((r, i) => ({ id: `legacy-${phase}-${i}`, version: '3', last_updated: '2026-01-01T00:00:00Z', ...r }));
}

const OFFICE_RULE: LiveRule = { id: 'hand-1', description: 'Allow office', action: 'skip', expression: '(ip.src eq 192.0.2.99)', enabled: true, logging: { enabled: false }, version: '2' };

/** example.com: hardened by the old script, plus one hand-made rule listed first. */
function addLegacyZone() {
  const fixture = legacyCase(LEGACY_CASE);
  writeInventory('example.com', readFixture(`legacy-script/${LEGACY_CASE}/inventory.yaml`));
  return api.addZone({
    summary: { id: IDS.com, name: 'example.com', accountId: ACCOUNT, plan: 'Free Website' },
    dns: fixture.dns,
    phases: {
      [CUSTOM]: [OFFICE_RULE, ...withIds(CUSTOM, fixture.phase(CUSTOM))],
      [RATE]: withIds(RATE, fixture.phase(RATE)),
      [REDIRECT]: withIds(REDIRECT, fixture.phase(REDIRECT)),
    },
    settings: { always_use_https: 'off', browser_check: 'off' },
    botManagement: { fight_mode: false, enable_js: false },
  });
}

/** example.net: in sync, plus three hand-made custom rules, so owned + unowned is 7 against a limit of 5. */
function addOverLimitZone() {
  writeInventory('example.net', NET_INVENTORY);
  const dns = [{ name: 'api.example.net', type: 'A', content: '192.0.2.10', proxied: true }];
  const live = liveFromDesired(render(defaultBaseline(), parseInventory(NET_INVENTORY), dns));
  live.phases[CUSTOM]?.splice(1, 1);
  for (let i = 0; i < 3; i++) live.phases[CUSTOM]?.push({ id: `hand-${i}`, description: `Hand rule ${i}`, action: 'skip', expression: `(ip.src eq 192.0.2.${i})` });
  return api.addZone({ summary: { id: IDS.net, name: 'example.net', accountId: ACCOUNT, plan: 'Free Website' }, dns, ...live });
}

/** example.org: a new zone with no rules and Bot Fight Mode off. */
function addNewZone() {
  writeInventory('example.org', ORG_INVENTORY);
  return api.addZone({
    summary: { id: IDS.org, name: 'example.org', accountId: ACCOUNT, plan: 'Free Website' },
    dns: [{ name: 'example.org', type: 'A', content: '192.0.2.20', proxied: true }],
    settings: { always_use_https: 'off', browser_check: 'off' },
    botManagement: { fight_mode: false, enable_js: false },
  });
}

const writesFor = (zoneId: string) => api.writes.filter((w) => w.zoneId === zoneId);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flarewall-apply-'));
  copyFileSync(DEFAULT_BASELINE_FILE, join(dir, 'baseline.yaml'));
  api = new FakeCloudflareApi();
  answers = [];
  asked = [];
  isTTY = true;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('apply dry run (C11)', () => {
  it('sends no write call, writes no backup, and prints the plan', async () => {
    addLegacyZone();
    const result = await cli('apply', 'example.com');
    expect(api.writes).toEqual([]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    expect(result.code).toBe(0);
    expect(result.out).toContain('replace legacy "Block non-standard ports" (id legacy-http_request_firewall_custom-0) with flarewall_ports');
    expect(result.out).toContain('setting always_use_https: "off" -> "on"');
    expect(result.out).toContain('example.com: dry run, nothing sent; pass --write to send');
    expect(asked).toEqual([]);
  });

  it('apply needs zone names or --all', async () => {
    addLegacyZone();
    expect((await cli('apply')).code).toBe(2);
    expect((await cli('apply', '--all', 'example.com')).code).toBe(2);
    expect(api.writes).toEqual([]);
  });
});

describe('apply --write (C12, C13)', () => {
  it('backs up, replaces legacy rules keeping their ids, keeps unowned rules last, and reads back in sync', async () => {
    const zone = addLegacyZone();
    const before = structuredClone(zone);
    answers = [true];
    const result = await cli('apply', 'example.com', '--write');
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(asked).toEqual(['Apply the baseline to example.com? [y/N] ']);

    // Backup: the state before the write, one file per part.
    const backupDir = join(dir, 'backups', 'example.com', STAMP);
    expect(result.out).toContain(`example.com: backup written to ${backupDir}`);
    expect(readdirSync(backupDir).sort()).toEqual([
      'always_use_https.json',
      'bot_management.json',
      'browser_check.json',
      `${RATE}.json`,
      `${CUSTOM}.json`,
      `${REDIRECT}.json`,
    ].sort());
    expect(JSON.parse(readFileSync(join(backupDir, `${CUSTOM}.json`), 'utf8'))).toEqual(before.phases[CUSTOM]);
    expect(JSON.parse(readFileSync(join(backupDir, 'always_use_https.json'), 'utf8'))).toEqual({ value: 'off' });

    // Legacy rules replaced in place, ids kept, no duplicates, unowned rule after the owned ones.
    const custom = zone.phases[CUSTOM] ?? [];
    expect(custom.map((r) => r.ref ?? r.description)).toEqual(['flarewall_ports', 'flarewall_probes', 'flarewall_hosting', 'flarewall_geo', 'Allow office']);
    expect(custom.map((r) => r.id)).toEqual([0, 1, 2, 3].map((i) => `legacy-${CUSTOM}-${i}`).concat('hand-1'));
    expect(custom[4]).toEqual({ id: 'hand-1', description: 'Allow office', action: 'skip', expression: '(ip.src eq 192.0.2.99)', enabled: true, logging: { enabled: false } });
    expect(zone.phases[RATE]?.map((r) => [r.ref, r.id])).toEqual([['flarewall_rate_limit', `legacy-${RATE}-0`]]);
    expect(zone.phases[REDIRECT]?.map((r) => [r.ref, r.id])).toEqual([
      ['flarewall_https', `legacy-${REDIRECT}-0`],
      ['flarewall_canonical_host', `legacy-${REDIRECT}-1`],
    ]);
    for (const w of writesFor(IDS.com)) if (w.method === 'updatePhase') for (const r of w.rules) expect(r).not.toHaveProperty('version');
    expect(zone.settings.always_use_https).toBe('on');
    // The zone has API and WordPress hosts, so browser_check and Bot Fight Mode stay as they were.
    expect(zone.settings.browser_check).toBe('off');
    expect(writesFor(IDS.com).some((w) => w.method === 'updateBotManagement')).toBe(false);
    expect(result.out).toContain('example.com: applied, read-back in sync');

    const status = await cli('status', 'example.com');
    expect(status.out).toMatch(/^example\.com\s+Free Website\s+in sync$/m);
    expect(status.code).toBe(0);

    // A second apply finds nothing to send.
    const again = await cli('apply', 'example.com', '--write', '--yes');
    expect(again.out).toContain('example.com: in sync, nothing to send');
    expect(again.code).toBe(0);
  });

  it('sends Bot Fight Mode with JavaScript detections together', async () => {
    addNewZone();
    const result = await cli('apply', 'example.org', '--write', '--yes');
    expect(result.code).toBe(0);
    expect(writesFor(IDS.org).filter((w) => w.method === 'updateBotManagement')).toEqual([
      { method: 'updateBotManagement', zoneId: IDS.org, state: { fight_mode: true, enable_js: true } },
    ]);
    expect(asked).toEqual([]);
  });

  it('a declined confirmation sends nothing and exits 0', async () => {
    addLegacyZone();
    answers = [false];
    const result = await cli('apply', 'example.com', '--write');
    expect(asked).toHaveLength(1);
    expect(api.writes).toEqual([]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    expect(result.out).toContain('example.com: declined, nothing sent');
    expect(result.code).toBe(0);
  });

  it('refuses --write with no TTY and no --yes, before any call', async () => {
    addLegacyZone();
    isTTY = false;
    const result = await cli('apply', 'example.com', '--write');
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/refusing to write/);
    expect(api.writes).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('limits and failures (C13, C14)', () => {
  it('skips a zone over the Free plan custom rule limit, and the next zone still applies', async () => {
    addOverLimitZone();
    addNewZone();
    const result = await cli('apply', 'example.net', 'example.org', '--write', '--yes');
    expect(result.err).toContain(
      'example.net: error: skipped, over the Free plan limit: http_request_firewall_custom would hold 7 rules (4 owned + 3 unowned); the Free plan allows 5',
    );
    expect(writesFor(IDS.net)).toEqual([]);
    expect(existsSync(join(dir, 'backups', 'example.net'))).toBe(false);
    expect(result.out).toContain('example.org: applied, read-back in sync');
    expect(result.code).toBe(2);
  });

  it('a failing write in one zone does not stop the next zone', async () => {
    addLegacyZone();
    addNewZone();
    api.fail('updatePhase', IDS.com, 'HTTP 500 from the API');
    const result = await cli('apply', '--all', '--write', '--yes');
    expect(result.err).toContain('example.com: error: HTTP 500 from the API');
    expect(result.out).toContain('example.org: applied, read-back in sync');
    expect(result.code).toBe(2);
  });

  it('a read-back that is not in sync is a failure', async () => {
    addNewZone();
    const update = api.updatePhase.bind(api);
    api.updatePhase = async (zoneId, phase, rules) => update(zoneId, phase, rules.map((r) => (r.ref === 'flarewall_ports' ? { ...r, enabled: false } : r)));
    const result = await cli('apply', 'example.org', '--write', '--yes');
    expect(result.err).toMatch(/example\.org: error: read-back is drift, not in sync: http_request_firewall_custom: changed flarewall_ports \(enabled\)/);
    expect(result.code).toBe(2);
  });
});

describe('restore (C15)', () => {
  it('restore --write of the apply backup returns the zone to its earlier state', async () => {
    const zone = addLegacyZone();
    const before = structuredClone({ phases: zone.phases, settings: zone.settings, botManagement: zone.botManagement });
    expect((await cli('apply', 'example.com', '--write', '--yes')).code).toBe(0);
    const backupDir = join(dir, 'backups', 'example.com', STAMP);

    const writesAfterApply = api.writes.length;
    const dry = await cli('restore', 'example.com', backupDir);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`example.com: restore from ${backupDir}`);
    expect(dry.out).toContain('example.com: dry run, nothing sent; pass --write to send');
    expect(api.writes).toHaveLength(writesAfterApply);

    const result = await cli('restore', 'example.com', STAMP, '--write', '--yes');
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    // A fresh backup of the applied state comes first, in its own directory.
    expect(result.out).toContain(`example.com: backup written to ${backupDir}-1`);
    expect(result.out).toContain('example.com: restored, read-back matches the backup');

    const strip = (rules: LiveRule[] | undefined) => rules?.map(({ version: _v, last_updated: _l, ...rest }) => rest);
    for (const phase of [CUSTOM, RATE, REDIRECT]) expect(strip(zone.phases[phase])).toEqual(strip(before.phases[phase]));
    expect(zone.settings).toEqual(before.settings);
    expect(zone.botManagement).toEqual(before.botManagement);
    expect((await cli('status', 'example.com')).out).toMatch(/^example\.com\s+Free Website\s+legacy$/m);
  });

  it('restore --write with no TTY and no --yes exits 2 with no write', async () => {
    addLegacyZone();
    expect((await cli('apply', 'example.com', '--write', '--yes')).code).toBe(0);
    const writes = api.writes.length;
    isTTY = false;
    const result = await cli('restore', 'example.com', STAMP, '--write');
    expect(result.code).toBe(2);
    expect(api.writes).toHaveLength(writes);
  });
});

describe('planZone', () => {
  it('keeps the owned rule id and drops a legacy rule for the same ref, so no rule appears twice', () => {
    const fixture = legacyCase(LEGACY_CASE);
    const desired = render(defaultBaseline(), fixture.inventory, fixture.dns);
    const live = liveFromDesired(desired);
    live.phases[CUSTOM]?.push({ id: 'old-ports', description: 'Block non-standard ports', action: 'block', expression: 'true' });
    const plan = planZone(desired, live);
    const custom = plan.phases.find((p) => p.phase === CUSTOM);
    expect(custom?.rules.map((r) => r.id)).toEqual([0, 1, 2, 3].map((i) => `${CUSTOM}-${i}`));
    expect(custom?.steps).toContainEqual({ kind: 'remove', id: 'old-ports', description: 'Block non-standard ports' });
    expect(custom?.write).toBe(true);
    expect(plan.phases.find((p) => p.phase === RATE)?.write).toBe(false);
  });
});

describe('applyInventoryZone', () => {
  it('renders the inventory against live DNS and dry-runs the zone with no write', async () => {
    addLegacyZone();
    const inventory = parseInventory(readFixture(`legacy-script/${LEGACY_CASE}/inventory.yaml`));
    const backup = async () => {
      throw new Error('a dry run writes no backup');
    };
    const result = await applyInventoryZone(api, defaultBaseline(), inventory, { backup });
    expect(result.outcome).toBe('dry run');
    expect(result.plan.zone).toBe('example.com');
    expect(api.writes).toEqual([]);
  });
});
