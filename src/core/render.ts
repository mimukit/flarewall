// render: turns the baseline and one zone's inventory into the payloads the zone should hold.
// Core module: no Node-only API here, so a Worker can run it.
import { PLACEHOLDERS, type Baseline, type Inventory, type Placeholder, type ProbePath, type RuleTemplate, type When } from './schema.js';

export const PHASES = ['http_request_firewall_custom', 'http_ratelimit', 'http_request_dynamic_redirect'] as const;
export type Phase = (typeof PHASES)[number];

export interface Rule {
  ref: string;
  description: string;
  action: string;
  expression: string;
  enabled?: boolean;
  action_parameters?: unknown;
  ratelimit?: unknown;
  id?: string;
}

export interface DesiredZone {
  zone: string;
  /** The redirect phase is absent when the inventory sets `redirects: skip`. */
  phases: Partial<Record<Phase, Rule[]>>;
  /** browser_check is present only when the zone has no API host. */
  settings: { always_use_https: 'on'; browser_check?: 'on' };
  /** Present only when the zone has no API host and no WordPress host. */
  botManagement?: { fight_mode: true; enable_js: true };
}

export interface DnsRecord {
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

const PATH = 'lower(http.request.uri.path)';

function hostSet(hosts: readonly string[]): string {
  return '{' + hosts.map((h) => `"${h}"`).join(' ') + '}';
}

function unlessHost(hosts: readonly string[]): string {
  return hosts.length > 0 ? ` and not http.host in ${hostSet(hosts)}` : '';
}

function probeClause(probe: ProbePath): string {
  if ('contains' in probe) return `(${PATH} contains "${probe.contains}")`;
  if ('ends_with' in probe) return `(ends_with(${PATH}, "${probe.ends_with}"))`;
  return `(starts_with(${PATH}, "${probe.starts_with}"))`;
}

/**
 * The origin IPs of the zone's WordPress hosts: the unique, sorted `content` of proxied
 * A and AAAA records whose name is a WordPress host. The old script does the same.
 */
export function wordpressOriginIps(inventory: Inventory, dnsRecords: readonly DnsRecord[]): string[] {
  const wordpress = new Set(inventory.hosts.wordpress);
  const ips = dnsRecords
    .filter((r) => r.proxied && (r.type === 'A' || r.type === 'AAAA') && wordpress.has(r.name))
    .map((r) => r.content);
  return [...new Set(ips)].sort();
}

function conditionHolds(when: When, inventory: Inventory): boolean {
  const { api, wordpress } = inventory.hosts;
  switch (when) {
    case 'always':
      return true;
    case 'geo':
      return inventory.geo?.enabled === true;
    case 'no_api_hosts':
      return api.length === 0;
    case 'no_hosts':
      return api.length === 0 && wordpress.length === 0;
    case 'canonical_host':
      return inventory.redirects === 'root' || inventory.redirects === 'www';
  }
}

function placeholderValues(
  baseline: Baseline,
  inventory: Inventory,
  dnsRecords: readonly DnsRecord[],
): Partial<Record<Placeholder, string | number>> {
  const { api, wordpress } = inventory.hosts;
  const ips = wordpressOriginIps(inventory, dnsRecords);
  const values: Partial<Record<Placeholder, string | number>> = {
    unless_api: unlessHost(api),
    unless_wordpress: unlessHost(wordpress),
    exempt:
      ' and not cf.client.bot' +
      ' and not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")' +
      unlessHost(api) +
      (ips.length > 0 ? ` and not ip.src in {${ips.join(' ')}}` : ''),
    asns: '{' + baseline.hosting_asns.join(' ') + '}',
    probe_paths: baseline.probe_paths.map(probeClause).join(' or '),
    rate_requests: inventory.rate_limit?.requests ?? baseline.rate_limit.requests,
  };
  if (inventory.geo?.enabled && inventory.geo.country !== undefined) values.geo_country = inventory.geo.country;
  if (inventory.redirects === 'root') {
    values.source_host = `www.${inventory.zone}`;
    values.target_host = inventory.zone;
  } else if (inventory.redirects === 'www') {
    values.source_host = inventory.zone;
    values.target_host = `www.${inventory.zone}`;
  }
  return values;
}

const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g;
const ONLY_PLACEHOLDER = /^\{\{([a-z_]+)\}\}$/;

function lookup(name: string, values: Partial<Record<Placeholder, string | number>>, ref: string): string | number {
  if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
    throw new RenderError(`rule ${ref}: unknown placeholder {{${name}}}`);
  }
  const value = values[name as Placeholder];
  if (value === undefined) {
    throw new RenderError(`rule ${ref}: placeholder {{${name}}} has no value for this zone`);
  }
  return value;
}

function expandString(text: string, values: Partial<Record<Placeholder, string | number>>, ref: string): string | number {
  const whole = ONLY_PLACEHOLDER.exec(text);
  if (whole?.[1] !== undefined) {
    const value = lookup(whole[1], values, ref);
    // A field that holds only a numeric placeholder, such as requests_per_period, stays a number.
    if (typeof value === 'number') return value;
  }
  if (text.replace(PLACEHOLDER_PATTERN, '').includes('{{')) {
    throw new RenderError(`rule ${ref}: malformed placeholder in ${JSON.stringify(text)}`);
  }
  return text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => String(lookup(name, values, ref)));
}

function expand(value: unknown, values: Partial<Record<Placeholder, string | number>>, ref: string): unknown {
  if (typeof value === 'string') return expandString(value, values, ref);
  if (Array.isArray(value)) return value.map((v) => expand(v, values, ref));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, values, ref)]));
  }
  return value;
}

function renderRule(template: RuleTemplate, values: Partial<Record<Placeholder, string | number>>): Rule {
  const expression = expandString(template.expression, values, template.ref);
  const rule: Rule = {
    ref: template.ref,
    description: template.description,
    action: template.action,
    expression: String(expression),
    enabled: template.enabled,
  };
  if (template.action_parameters !== undefined) {
    rule.action_parameters = expand(template.action_parameters, values, template.ref);
  }
  if (template.ratelimit !== undefined) rule.ratelimit = expand(template.ratelimit, values, template.ref);
  return rule;
}

/**
 * Renders the desired state of one zone. `dnsRecords` are the zone's live DNS records;
 * render uses them only to find the WordPress origin IPs. Owned rules keep baseline order.
 * Throws RenderError on an unknown placeholder or a placeholder with no value for the zone.
 */
export function render(baseline: Baseline, inventory: Inventory, dnsRecords: readonly DnsRecord[]): DesiredZone {
  const values = placeholderValues(baseline, inventory, dnsRecords);
  const phases: Partial<Record<Phase, Rule[]>> = {};
  for (const phase of PHASES) {
    if (phase === 'http_request_dynamic_redirect' && inventory.redirects === 'skip') continue;
    phases[phase] = baseline.rules[phase]
      .filter((t) => conditionHolds(t.when, inventory))
      .map((t) => renderRule(t, values));
  }

  const desired: DesiredZone = {
    zone: inventory.zone,
    phases,
    settings: { always_use_https: baseline.settings.always_use_https.value },
  };
  if (conditionHolds(baseline.settings.browser_check.when, inventory)) {
    desired.settings.browser_check = baseline.settings.browser_check.value;
  }
  if (conditionHolds(baseline.bot_management.when, inventory)) {
    desired.botManagement = { fight_mode: true, enable_js: true };
  }
  return desired;
}
