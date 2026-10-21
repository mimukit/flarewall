// Detects rules that the old cf-security-setup.sh script wrote, so flarewall can adopt them.
// Core module: no Node-only API here, so a Worker can run it.

/** Exact descriptions the old script gives its custom and rate limiting rules. */
export const LEGACY_DESCRIPTIONS: ReadonlySet<string> = new Set([
  'Block non-standard ports',
  'Block scanner probes',
  'Hosting networks (verified bots, API hosts, origins allowed)',
  'Rate limit per IP',
]);

/** The old geo rule names its country in the description, so match any two-letter code. */
export const LEGACY_GEO_DESCRIPTION = /^Non-[A-Z]{2} traffic \(verified bots, API hosts, origins allowed\)$/;

/** Refs the old script puts on its redirect rules. */
export const LEGACY_REFS: ReadonlySet<string> = new Set(['cf_security_https', 'cf_security_canonical_host']);

export interface RuleIdentity {
  ref?: string | null;
  description?: string | null;
}

/** True when the rule is one the old script wrote. */
export function isLegacyRule(rule: RuleIdentity): boolean {
  if (typeof rule.ref === 'string' && LEGACY_REFS.has(rule.ref)) return true;
  if (typeof rule.description !== 'string') return false;
  return LEGACY_DESCRIPTIONS.has(rule.description) || LEGACY_GEO_DESCRIPTION.test(rule.description);
}

/** The flarewall ref that takes the place of each legacy description. */
const LEGACY_DESCRIPTION_TARGETS: ReadonlyMap<string, string> = new Map([
  ['Block non-standard ports', 'flarewall_ports'],
  ['Block scanner probes', 'flarewall_probes'],
  ['Hosting networks (verified bots, API hosts, origins allowed)', 'flarewall_hosting'],
  ['Rate limit per IP', 'flarewall_rate_limit'],
]);

/** The flarewall ref that takes the place of each legacy ref. */
const LEGACY_REF_TARGETS: ReadonlyMap<string, string> = new Map([
  ['cf_security_https', 'flarewall_https'],
  ['cf_security_canonical_host', 'flarewall_canonical_host'],
]);

/** The ref of the flarewall rule that replaces a legacy rule, or undefined when the rule is not legacy. */
export function legacyTargetRef(rule: RuleIdentity): string | undefined {
  if (typeof rule.ref === 'string') {
    const target = LEGACY_REF_TARGETS.get(rule.ref);
    if (target !== undefined) return target;
  }
  if (typeof rule.description !== 'string') return undefined;
  if (LEGACY_GEO_DESCRIPTION.test(rule.description)) return 'flarewall_geo';
  return LEGACY_DESCRIPTION_TARGETS.get(rule.description);
}
