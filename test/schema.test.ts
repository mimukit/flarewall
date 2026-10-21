import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBaseline, parseInventory, SchemaError } from '../src/core/schema.js';
import { DEFAULT_BASELINE_FILE, defaultBaseline, readFixture } from './helpers.js';

const INVENTORY = readFixture('legacy-script/api-wordpress-geo-root/inventory.yaml');

describe('baseline schema', () => {
  it('parses the default baseline', () => {
    const baseline = defaultBaseline();
    expect(baseline.version).toBe(1);
    expect(baseline.rules.http_request_firewall_custom.map((r) => r.ref)).toEqual([
      'flarewall_ports',
      'flarewall_probes',
      'flarewall_hosting',
      'flarewall_geo',
    ]);
  });

  it('rejects an unknown version', () => {
    const text = readFileSync(DEFAULT_BASELINE_FILE, 'utf8').replace(/^version: 1$/m, 'version: 2');
    expect(() => parseBaseline(text)).toThrow(SchemaError);
  });

  it('rejects a ref without the flarewall_ prefix', () => {
    const text = readFileSync(DEFAULT_BASELINE_FILE, 'utf8').replace('ref: flarewall_ports', 'ref: ports');
    expect(() => parseBaseline(text)).toThrow(/flarewall_/);
  });

  it('rejects a duplicate ref', () => {
    const text = readFileSync(DEFAULT_BASELINE_FILE, 'utf8').replace('ref: flarewall_probes', 'ref: flarewall_ports');
    expect(() => parseBaseline(text)).toThrow(/duplicate rule ref flarewall_ports/);
  });
});

describe('inventory schema', () => {
  it('parses a fixture inventory', () => {
    const inventory = parseInventory(INVENTORY);
    expect(inventory.hosts).toEqual({ api: ['api.example.com'], wordpress: ['blog.example.com'] });
    expect(inventory.geo).toEqual({ enabled: true, country: 'XX' });
    expect(inventory.redirects).toBe('root');
  });

  it('defaults host roles to empty lists', () => {
    const inventory = parseInventory(readFixture('legacy-script/no-hosts-www/inventory.yaml'));
    expect(inventory.hosts).toEqual({ api: [], wordpress: [] });
    expect(inventory.geo).toBeUndefined();
  });

  it('rejects an unknown version', () => {
    expect(() => parseInventory(INVENTORY.replace('version: 1', 'version: 2'))).toThrow(SchemaError);
  });

  it('rejects geo enabled without a country', () => {
    expect(() => parseInventory(INVENTORY.replace('  country: XX\n', ''))).toThrow(/geo.country is required/);
  });

  it('accepts geo disabled without a country', () => {
    const inventory = parseInventory(INVENTORY.replace('  enabled: true\n  country: XX\n', '  enabled: false\n'));
    expect(inventory.geo).toEqual({ enabled: false });
  });

  it('rejects an unknown redirect mode', () => {
    expect(() => parseInventory(INVENTORY.replace('redirects: root', 'redirects: apex'))).toThrow(SchemaError);
  });

  it('rejects a host that is both an API host and a WordPress host', () => {
    expect(() => parseInventory(INVENTORY.replace('wordpress: [blog.example.com]', 'wordpress: [api.example.com]'))).toThrow(
      /both an API host and a WordPress host/,
    );
  });
});
