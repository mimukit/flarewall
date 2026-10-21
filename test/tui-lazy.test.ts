// `flarewall tui` loads Ink and React with a dynamic import, so no other command loads them.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/run.js';
import { FakeCloudflareApi } from './fake-api.js';
import { DEFAULT_BASELINE_FILE } from './helpers.js';

const loads = vi.hoisted(() => ({ ink: 0, react: 0 }));

vi.mock('ink', () => {
  loads.ink += 1;
  throw new Error('ink was loaded');
});
vi.mock('react', () => {
  loads.react += 1;
  throw new Error('react was loaded');
});

let dir: string;
const api = new FakeCloudflareApi();

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flarewall-lazy-'));
  copyFileSync(DEFAULT_BASELINE_FILE, join(dir, 'baseline.yaml'));
  loads.ink = 0;
  loads.react = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ CLOUDFLARE_API_TOKEN: 'test-token', FLAREWALL_DATA: dir });

describe('tui loading', () => {
  it("run(['status']) does not load ink or react", async () => {
    const c = capture();
    expect(await run(['status'], env(), c.io, { api: () => api })).toBe(0);
    expect(loads).toEqual({ ink: 0, react: 0 });
  });

  it("run(['tui']) loads ink, so the mock above sees a load", async () => {
    const c = capture();
    expect(await run(['tui'], env(), c.io, { api: () => api, isTTY: true })).toBe(2);
    expect(loads.ink + loads.react).toBeGreaterThan(0);
  });

  it('tui with no TTY on stdin prints an error and exits 2, before it loads ink', async () => {
    const c = capture();
    expect(await run(['tui'], env(), c.io, { api: () => api, isTTY: false })).toBe(2);
    expect(c.err.join('\n')).toMatch(/stdin is not a terminal/);
    expect(loads).toEqual({ ink: 0, react: 0 });
  });

  it('tui needs CLOUDFLARE_API_TOKEN', async () => {
    const c = capture();
    expect(await run(['tui'], { FLAREWALL_DATA: dir }, c.io, { api: () => api, isTTY: true })).toBe(2);
    expect(c.err.join('\n')).toMatch(/CLOUDFLARE_API_TOKEN is not set/);
  });
});
