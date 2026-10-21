import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { DEFAULT_BASELINE_FILE } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('flarewall init', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flarewall-init-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies the default baseline to <data>/baseline.yaml from --data', async () => {
    const c = capture();
    expect(await run(['init', '--data', dir], {}, c.io)).toBe(0);
    expect(readFileSync(join(dir, 'baseline.yaml'), 'utf8')).toBe(readFileSync(DEFAULT_BASELINE_FILE, 'utf8'));
    expect(c.out.join('\n')).toContain(join(dir, 'baseline.yaml'));
  });

  it('reads the data path from FLAREWALL_DATA', async () => {
    const data = join(dir, 'data');
    expect(await run(['init'], { FLAREWALL_DATA: data }, capture().io)).toBe(0);
    expect(readFileSync(join(data, 'baseline.yaml'), 'utf8')).toBe(readFileSync(DEFAULT_BASELINE_FILE, 'utf8'));
  });

  it('refuses to overwrite an existing baseline', async () => {
    writeFileSync(join(dir, 'baseline.yaml'), 'mine\n');
    const c = capture();
    expect(await run(['init', '--data', dir], {}, c.io)).toBe(2);
    expect(readFileSync(join(dir, 'baseline.yaml'), 'utf8')).toBe('mine\n');
    expect(c.err.join('\n')).toMatch(/already exists/);
  });

  it('fails with no data path', async () => {
    const c = capture();
    expect(await run(['init'], {}, c.io)).toBe(2);
    expect(c.err.join('\n')).toMatch(/FLAREWALL_DATA/);
  });

  it('rejects an unknown command', async () => {
    expect(await run(['nope'], {}, capture().io)).toBe(2);
  });
});
