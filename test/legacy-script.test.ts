// C4: render matches the JSON the old cf-security-setup.sh builds for the same input.
// The fixture JSON came from the script's own jq builders (custom_rules, rate_rules,
// redirect_rules), run offline with the geo country set to XX. See .afkkit/phase2-notes.md.
//
// Compared fields: action, expression, ratelimit, action_parameters, and rule order.
// Not compared, by design:
//  - ref: flarewall uses flarewall_ refs; the script's custom and rate rules carry none.
//  - description: flarewall uses new descriptions so that legacy detection, which keys on
//    the script's descriptions, can tell the two apart.
//  - enabled on custom and rate rules: the script omits it, and Cloudflare defaults it to true.
//    flarewall sends enabled: true. Redirect rules compare enabled, since the script sends it.
import { describe, expect, it } from 'vitest';
import { render } from '../src/core/render.js';
import { defaultBaseline, legacyCase } from './helpers.js';

const pick = (rule: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => rule[k] !== undefined).map((k) => [k, rule[k]]));

const CUSTOM_KEYS = ['action', 'expression'];
const RATE_KEYS = ['action', 'expression', 'ratelimit'];
const REDIRECT_KEYS = ['action', 'expression', 'enabled', 'action_parameters'];

describe.each(['api-wordpress-geo-root', 'no-hosts-www'])('render matches the old script: %s', (name) => {
  const fixture = legacyCase(name);
  const desired = render(defaultBaseline(), fixture.inventory, fixture.dns);

  const compare = (phase: 'http_request_firewall_custom' | 'http_ratelimit' | 'http_request_dynamic_redirect', keys: string[]) => {
    const ours = (desired.phases[phase] ?? []).map((r) => pick(r as unknown as Record<string, unknown>, keys));
    const script = fixture.phase(phase).map((r) => pick(r, keys));
    expect(ours).toEqual(script);
  };

  it('custom rules', () => compare('http_request_firewall_custom', CUSTOM_KEYS));
  it('rate limiting rules', () => compare('http_ratelimit', RATE_KEYS));
  it('redirect rules, in order', () => compare('http_request_dynamic_redirect', REDIRECT_KEYS));

  it('every rendered rule is enabled and has a flarewall_ ref', () => {
    for (const rules of Object.values(desired.phases)) {
      for (const rule of rules ?? []) {
        expect(rule.ref).toMatch(/^flarewall_/);
        expect(rule.enabled).toBe(true);
      }
    }
  });
});

describe('settings follow the old script', () => {
  it('a zone with API and WordPress hosts gets always_use_https only', () => {
    const fixture = legacyCase('api-wordpress-geo-root');
    const desired = render(defaultBaseline(), fixture.inventory, fixture.dns);
    expect(desired.settings).toEqual({ always_use_https: 'on' });
    expect(desired.botManagement).toBeUndefined();
  });

  it('a zone with no hosts gets browser_check and Bot Fight Mode with JavaScript detections', () => {
    const fixture = legacyCase('no-hosts-www');
    const desired = render(defaultBaseline(), fixture.inventory, fixture.dns);
    expect(desired.settings).toEqual({ always_use_https: 'on', browser_check: 'on' });
    expect(desired.botManagement).toEqual({ fight_mode: true, enable_js: true });
  });
});
