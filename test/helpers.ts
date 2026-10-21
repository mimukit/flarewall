import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBaseline, parseInventory, type Baseline, type Inventory } from '../src/core/schema.js';
import type { DnsRecord } from '../src/core/render.js';

export const DEFAULT_BASELINE_FILE = fileURLToPath(new URL('../src/baseline/default.yaml', import.meta.url));

export function fixturePath(relative: string): string {
  return fileURLToPath(new URL(`./fixtures/${relative}`, import.meta.url));
}

export function readFixture(relative: string): string {
  return readFileSync(fixturePath(relative), 'utf8');
}

export function defaultBaseline(): Baseline {
  return parseBaseline(readFileSync(DEFAULT_BASELINE_FILE, 'utf8'));
}

export function legacyCase(name: string): {
  inventory: Inventory;
  dns: DnsRecord[];
  phase: (phase: string) => Record<string, unknown>[];
} {
  return {
    inventory: parseInventory(readFixture(`legacy-script/${name}/inventory.yaml`)),
    dns: JSON.parse(readFixture(`legacy-script/${name}/dns.json`)) as DnsRecord[],
    phase: (phase) => JSON.parse(readFixture(`legacy-script/${name}/${phase}.json`)) as Record<string, unknown>[],
  };
}
