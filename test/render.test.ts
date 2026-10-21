import { describe, expect, it } from 'vitest';
import { render, RenderError, wordpressOriginIps, type DnsRecord } from '../src/core/render.js';
import { parseInventory, type Baseline } from '../src/core/schema.js';
import { defaultBaseline, legacyCase, readFixture } from './helpers.js';

const INVENTORY_TEXT = readFixture('legacy-script/api-wordpress-geo-root/inventory.yaml');

describe('render snapshots', () => {
  it.each(['api-wordpress-geo-root', 'no-hosts-www'])('full render output: %s', (name) => {
    const fixture = legacyCase(name);
    expect(render(defaultBaseline(), fixture.inventory, fixture.dns)).toMatchSnapshot();
  });
});

describe('render', () => {
  const fixture = legacyCase('api-wordpress-geo-root');

  it('takes WordPress origin IPs from proxied A and AAAA records of WordPress hosts only', () => {
    const dns: DnsRecord[] = [
      ...fixture.dns,
      { name: 'blog.example.com', type: 'A', content: '192.0.2.10', proxied: true },
    ];
    expect(wordpressOriginIps(fixture.inventory, dns)).toEqual(['192.0.2.10', '2001:db8::10']);
  });

  it('omits the geo rule when geo is off', () => {
    const inventory = parseInventory(INVENTORY_TEXT.replace('  enabled: true\n  country: XX\n', '  enabled: false\n'));
    const refs = render(defaultBaseline(), inventory, fixture.dns).phases.http_request_firewall_custom?.map((r) => r.ref);
    expect(refs).toEqual(['flarewall_ports', 'flarewall_probes', 'flarewall_hosting']);
  });

  it('uses the inventory rate limit over the baseline default', () => {
    const inventory = parseInventory(INVENTORY_TEXT.replace('requests: 300', 'requests: 120'));
    const rule = render(defaultBaseline(), inventory, fixture.dns).phases.http_ratelimit?.[0];
    expect(rule?.ratelimit).toMatchObject({ requests_per_period: 120 });
  });

  it('uses the baseline rate limit when the inventory sets none', () => {
    const inventory = parseInventory(INVENTORY_TEXT.replace('rate_limit:\n  requests: 300\n', ''));
    const rule = render(defaultBaseline(), inventory, fixture.dns).phases.http_ratelimit?.[0];
    expect(rule?.ratelimit).toMatchObject({ requests_per_period: 300 });
  });

  it('keeps only the HTTPS redirect in https mode', () => {
    const inventory = parseInventory(INVENTORY_TEXT.replace('redirects: root', 'redirects: https'));
    const rules = render(defaultBaseline(), inventory, fixture.dns).phases.http_request_dynamic_redirect;
    expect(rules?.map((r) => r.ref)).toEqual(['flarewall_https']);
  });

  it('leaves the redirect phase out in skip mode', () => {
    const inventory = parseInventory(INVENTORY_TEXT.replace('redirects: root', 'redirects: skip'));
    const desired = render(defaultBaseline(), inventory, fixture.dns);
    expect(Object.keys(desired.phases)).toEqual(['http_request_firewall_custom', 'http_ratelimit']);
  });

  it('gives a WordPress-only zone browser_check but not Bot Fight Mode', () => {
    const inventory = parseInventory(INVENTORY_TEXT.replace('api: [api.example.com]', 'api: []'));
    const desired = render(defaultBaseline(), inventory, fixture.dns);
    expect(desired.settings).toEqual({ always_use_https: 'on', browser_check: 'on' });
    expect(desired.botManagement).toBeUndefined();
  });

  it('fails on an unknown placeholder', () => {
    const baseline: Baseline = structuredClone(defaultBaseline());
    baseline.rules.http_request_firewall_custom[0]!.expression = '(ip.src in {{origin_ips}})';
    expect(() => render(baseline, fixture.inventory, fixture.dns)).toThrow(RenderError);
    expect(() => render(baseline, fixture.inventory, fixture.dns)).toThrow(/unknown placeholder \{\{origin_ips\}\}/);
  });

  it('fails on a malformed placeholder', () => {
    const baseline: Baseline = structuredClone(defaultBaseline());
    baseline.rules.http_request_firewall_custom[0]!.expression = '(ip.src.asnum in {{ asns }})';
    expect(() => render(baseline, fixture.inventory, fixture.dns)).toThrow(/malformed placeholder/);
  });

  it('fails when a placeholder has no value for the zone', () => {
    const baseline: Baseline = structuredClone(defaultBaseline());
    baseline.rules.http_request_firewall_custom[0]!.expression = '(ip.src.country ne "{{geo_country}}")';
    const inventory = parseInventory(INVENTORY_TEXT.replace('  enabled: true\n  country: XX\n', '  enabled: false\n'));
    expect(() => render(baseline, inventory, fixture.dns)).toThrow(/has no value for this zone/);
  });
});
