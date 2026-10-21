// diffZone unit cases: the field allowlist and the parts it leaves alone.
import { describe, expect, it } from 'vitest';
import { diffZone, type LiveZone } from '../src/core/diff.js';
import { render, type DesiredZone } from '../src/core/render.js';
import { liveFromDesired } from './fake-api.js';
import { defaultBaseline, legacyCase } from './helpers.js';

function setup(name = 'api-wordpress-geo-root'): { desired: DesiredZone; live: LiveZone } {
  const fixture = legacyCase(name);
  const desired = render(defaultBaseline(), fixture.inventory, fixture.dns);
  return { desired, live: liveFromDesired(desired) };
}

describe('diffZone', () => {
  it('ignores fields outside the allowlist, and enabled missing counts as true', () => {
    const { desired, live } = setup();
    for (const rule of live.phases.http_request_firewall_custom ?? []) {
      delete rule.enabled;
      rule.logging = { enabled: true };
    }
    expect(diffZone(desired, live).state).toBe('in sync');
  });

  it('enabled false is a change', () => {
    const { desired, live } = setup();
    const rule = live.phases.http_request_firewall_custom?.[0];
    if (rule === undefined) throw new Error('no rule');
    rule.enabled = false;
    const diff = diffZone(desired, live);
    expect(diff.state).toBe('drift');
    expect(diff.changes).toEqual([expect.objectContaining({ kind: 'changed', ref: rule.ref, fields: ['enabled'] })]);
  });

  it('sorts ratelimit characteristics before comparing', () => {
    const { desired, live } = setup();
    const rule = live.phases.http_ratelimit?.[0];
    const ratelimit = rule?.ratelimit as { characteristics: string[] } | undefined;
    if (ratelimit === undefined) throw new Error('no rate limit rule');
    ratelimit.characteristics.reverse();
    expect(diffZone(desired, live).state).toBe('in sync');
  });

  it('compares only characteristics, period, requests_per_period, and mitigation_timeout in ratelimit', () => {
    const { desired, live } = setup();
    const ratelimit = live.phases.http_ratelimit?.[0]?.ratelimit as Record<string, unknown> | undefined;
    if (ratelimit === undefined) throw new Error('no rate limit rule');
    ratelimit.requests_to_origin = false;
    ratelimit.counting_expression = '';
    expect(diffZone(desired, live).state).toBe('in sync');
    ratelimit.mitigation_timeout = 60;
    expect(diffZone(desired, live).changes).toEqual([expect.objectContaining({ kind: 'changed', ref: 'flarewall_rate_limit', fields: ['ratelimit'] })]);
  });

  it('reports owned rule order, a missing rule, and an extra owned rule', () => {
    const { desired, live } = setup();
    const custom = live.phases.http_request_firewall_custom ?? [];
    custom.reverse();
    live.phases.http_ratelimit = [{ ref: 'flarewall_old', description: 'gone', action: 'block', expression: 'true' }];
    const kinds = diffZone(desired, live).changes.map((c) => `${c.kind} ${'phase' in c ? c.phase : ''}`.trim());
    expect(kinds).toEqual(['order http_request_firewall_custom', 'extra http_ratelimit', 'missing http_ratelimit']);
  });

  it('compares a managed setting and bot management, and leaves unmanaged ones alone', () => {
    const managed = setup('no-hosts-www');
    managed.live.settings.browser_check = 'off';
    managed.live.botManagement = { fight_mode: false, enable_js: true };
    expect(diffZone(managed.desired, managed.live).changes.map((c) => c.kind)).toEqual(['setting', 'bot_management']);

    const unmanaged = setup('api-wordpress-geo-root');
    unmanaged.live.settings.browser_check = 'off';
    unmanaged.live.botManagement = { fight_mode: false };
    expect(diffZone(unmanaged.desired, unmanaged.live).state).toBe('in sync');
  });

  it('leaves the redirect phase alone when redirects is skip', () => {
    const { desired, live } = setup();
    delete desired.phases.http_request_dynamic_redirect;
    live.phases.http_request_dynamic_redirect = [{ ref: 'flarewall_https', description: 'edited', action: 'redirect', expression: 'true' }];
    expect(diffZone(desired, live).state).toBe('in sync');
  });
});
