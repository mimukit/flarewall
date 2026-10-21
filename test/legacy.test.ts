import { describe, expect, it } from 'vitest';
import { isLegacyRule } from '../src/core/legacy.js';
import { render } from '../src/core/render.js';
import { defaultBaseline, legacyCase } from './helpers.js';

describe('isLegacyRule', () => {
  it('matches every rule the old script builds', () => {
    for (const name of ['api-wordpress-geo-root', 'no-hosts-www']) {
      const fixture = legacyCase(name);
      for (const phase of ['http_request_firewall_custom', 'http_ratelimit', 'http_request_dynamic_redirect']) {
        for (const rule of fixture.phase(phase)) {
          expect(isLegacyRule(rule as { ref?: string; description?: string }), JSON.stringify(rule.description)).toBe(true);
        }
      }
    }
  });

  it('matches the geo rule for any two-letter country', () => {
    expect(isLegacyRule({ description: 'Non-QZ traffic (verified bots, API hosts, origins allowed)' })).toBe(true);
    expect(isLegacyRule({ description: 'Non-Qz traffic (verified bots, API hosts, origins allowed)' })).toBe(false);
  });

  it('does not match flarewall rules', () => {
    const fixture = legacyCase('api-wordpress-geo-root');
    const desired = render(defaultBaseline(), fixture.inventory, fixture.dns);
    for (const rules of Object.values(desired.phases)) {
      for (const rule of rules ?? []) expect(isLegacyRule(rule)).toBe(false);
    }
  });

  it('does not match a hand-made rule', () => {
    expect(isLegacyRule({ description: 'Block my admin path', ref: 'abc123' })).toBe(false);
    expect(isLegacyRule({})).toBe(false);
  });
});
