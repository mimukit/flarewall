// C7 to C10: status, diff, and add, driven through the CLI with an in-memory CloudflareApi.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { render, type Phase } from '../src/core/render.js';
import { parseInventory } from '../src/core/schema.js';
import { FakeCloudflareApi, liveFromDesired } from './fake-api.js';
import { DEFAULT_BASELINE_FILE, defaultBaseline, legacyCase } from './helpers.js';

const ACCOUNT = '01a7362d577a6c3019a474fd6f485823';
const IDS = {
  com: '023e105f4ecef8ad9ca31a8372d0c353',
  net: '0123456789abcdef0123456789abcdef',
  org: '1b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
};
const CUSTOM: Phase = 'http_request_firewall_custom';

const NET_INVENTORY = `version: 1
zone: example.net
zone_id: "${IDS.net}"
hosts:
  api: [api.example.net]
  wordpress: [blog.example.net]
geo:
  enabled: true
  country: XX
redirects: root
`;
const NET_DNS = [
  { name: 'api.example.net', type: 'A', content: '192.0.2.10', proxied: true },
  { name: 'blog.example.net', type: 'A', content: '198.51.100.7', proxied: true },
  { name: 'mail.example.net', type: 'A', content: '203.0.113.5', proxied: false },
];

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

let dir: string;
let api: FakeCloudflareApi;
const env = () => ({ CLOUDFLARE_API_TOKEN: 'test-token', FLAREWALL_DATA: dir });
const cli = async (...argv: string[]) => {
  const c = capture();
  const code = await run(argv, env(), c.io, { api: () => api });
  return { code, out: c.out.join('\n'), err: c.err.join('\n') };
};

function writeInventory(name: string, text: string) {
  mkdirSync(join(dir, 'inventory', ACCOUNT), { recursive: true });
  writeFileSync(join(dir, 'inventory', ACCOUNT, `${name}.yaml`), text);
}

/** example.com: the old script hardened it (fixture no-hosts-www). */
function addLegacyZone() {
  const fixture = legacyCase('no-hosts-www');
  writeInventory('example.com', readFileSync(join(import.meta.dirname, 'fixtures/legacy-script/no-hosts-www/inventory.yaml'), 'utf8'));
  api.addZone({
    summary: { id: IDS.com, name: 'example.com', accountId: ACCOUNT, plan: 'Free Website' },
    dns: fixture.dns,
    phases: {
      http_request_firewall_custom: fixture.phase('http_request_firewall_custom'),
      http_ratelimit: fixture.phase('http_ratelimit'),
      http_request_dynamic_redirect: fixture.phase('http_request_dynamic_redirect'),
    },
    settings: { always_use_https: 'on', browser_check: 'on' },
    botManagement: { fight_mode: true, enable_js: true },
  });
}

/** example.net: live state equals the render output. */
function addInSyncZone() {
  writeInventory('example.net', NET_INVENTORY);
  const desired = render(defaultBaseline(), parseInventory(NET_INVENTORY), NET_DNS);
  return api.addZone({
    summary: { id: IDS.net, name: 'example.net', accountId: ACCOUNT, plan: 'Free Website' },
    dns: NET_DNS,
    ...liveFromDesired(desired),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flarewall-status-'));
  copyFileSync(DEFAULT_BASELINE_FILE, join(dir, 'baseline.yaml'));
  api = new FakeCloudflareApi();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('status and diff (C7, C10)', () => {
  it('a zone the old script hardened is legacy, exit 1', async () => {
    addLegacyZone();
    const status = await cli('status');
    expect(status.code).toBe(1);
    expect(status.out).toMatch(/^example\.com\s+Free Website\s+legacy$/m);
    const diff = await cli('diff');
    expect(diff.code).toBe(1);
    expect(diff.out).toContain('legacy "Block non-standard ports"');
  });

  it('a zone whose live state equals render output is in sync, exit 0', async () => {
    addInSyncZone();
    const status = await cli('status');
    expect(status.out).toMatch(/^example\.net\s+Free Website\s+in sync$/m);
    expect(status.code).toBe(0);
    const diff = await cli('diff');
    expect(diff.code).toBe(0);
    expect(diff.out).toBe('example.net: in sync');
    expect(api.writes).toEqual([]);
  });

  it('an edited owned rule is drift, exit 1, and diff names its ref', async () => {
    const zone = addInSyncZone();
    const probes = zone.phases[CUSTOM]?.find((r) => r.ref === 'flarewall_probes');
    if (probes === undefined) throw new Error('fixture has no flarewall_probes rule');
    probes.expression = '(http.user_agent eq "")';
    const status = await cli('status');
    expect(status.out).toMatch(/^example\.net\s+Free Website\s+drift$/m);
    expect(status.code).toBe(1);
    const diff = await cli('diff');
    expect(diff.code).toBe(1);
    expect(diff.out).toMatch(/http_request_firewall_custom: changed flarewall_probes ".+" \(expression\)/);
    expect(diff.out).not.toMatch(/flarewall_ports/);
  });

  it('narrows both commands to the named zones', async () => {
    addLegacyZone();
    addInSyncZone();
    const status = await cli('status', 'example.net');
    expect(status.code).toBe(0);
    expect(status.out).not.toContain('example.com');
    expect((await cli('diff', 'example.com')).out).not.toContain('example.net');
  });
});

describe('unowned rules (C8)', () => {
  it('a hand-made rule with no flarewall_ ref is unowned, not drift', async () => {
    const zone = addInSyncZone();
    zone.phases[CUSTOM]?.push({ id: 'hand-1', description: 'Allow office', action: 'skip', expression: 'ip.src eq 192.0.2.99', enabled: true });
    const status = await cli('status');
    expect(status.out).toMatch(/^example\.net\s+Free Website\s+in sync$/m);
    expect(status.code).toBe(0);
    const diff = await cli('diff');
    expect(diff.code).toBe(0);
    expect(diff.out).toContain('http_request_firewall_custom: unowned "Allow office" (id hand-1)');
  });
});

describe('not managed and add (C9)', () => {
  it('a zone visible to the token with no inventory is not managed, exit 0', async () => {
    addInSyncZone();
    api.addZone({ summary: { id: IDS.org, name: 'example.org', accountId: ACCOUNT, plan: 'Free Website' } });
    const status = await cli('status');
    expect(status.out).toMatch(/^example\.org\s+Free Website\s+not managed$/m);
    expect(status.code).toBe(0);
  });

  it('add writes the inventory file, then refuses a second time', async () => {
    api.addZone({
      summary: { id: IDS.org, name: 'example.org', accountId: ACCOUNT, plan: 'Free Website' },
      dns: [
        { name: 'www.example.org', type: 'CNAME', content: 'example.org', proxied: true },
        { name: 'example.org', type: 'A', content: '192.0.2.20', proxied: true },
        { name: 'mail.example.org', type: 'A', content: '192.0.2.21', proxied: false },
      ],
    });
    const path = join(dir, 'inventory', ACCOUNT, 'example.org.yaml');
    const first = await cli('add', 'example.org');
    expect(first.code).toBe(0);
    const text = readFileSync(path, 'utf8');
    expect(parseInventory(text)).toEqual({
      version: 1,
      zone: 'example.org',
      zone_id: IDS.org,
      hosts: { api: [], wordpress: [] },
      redirects: 'root',
    });
    expect(text).toContain('#   example.org\n#   www.example.org\n');
    expect(text).not.toContain('mail.example.org');

    writeFileSync(path, 'mine\n');
    const second = await cli('add', 'example.org');
    expect(second.code).toBe(2);
    expect(second.err).toMatch(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe('mine\n');
  });

  it('add refuses a zone the token cannot see', async () => {
    api.addZone({ summary: { id: IDS.net, name: 'example.net', accountId: ACCOUNT, plan: 'Free Website' } });
    const result = await cli('add', 'example.org');
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/not found/);
    expect(existsSync(join(dir, 'inventory'))).toBe(false);
  });
});

describe('errors (C10)', () => {
  it('one zone failing getPhase is error, the others still report, exit 2', async () => {
    addLegacyZone();
    addInSyncZone();
    api.fail('getPhase', IDS.com, 'Authentication error');
    const status = await cli('status');
    expect(status.code).toBe(2);
    expect(status.out).toMatch(/^example\.com\s+Free Website\s+error: Authentication error$/m);
    expect(status.out).toMatch(/^example\.net\s+Free Website\s+in sync$/m);
    const diff = await cli('diff');
    expect(diff.code).toBe(2);
    expect(diff.out).toContain('example.net: in sync');
  });

  it('a missing token exits 2 with a clear message', async () => {
    addInSyncZone();
    for (const command of ['status', 'diff', 'add']) {
      const c = capture();
      const code = await run(command === 'add' ? [command, 'example.net'] : [command], { FLAREWALL_DATA: dir }, c.io, { api: () => api });
      expect(code).toBe(2);
      expect(c.err.join('\n')).toMatch(/CLOUDFLARE_API_TOKEN is not set/);
    }
  });

  it('a bad inventory file is a data error, exit 2', async () => {
    addInSyncZone();
    writeInventory('broken', 'version: 2\n');
    const status = await cli('status');
    expect(status.code).toBe(2);
    expect(status.err).toContain('broken.yaml');
  });
});
