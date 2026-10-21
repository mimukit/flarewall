// Zod schemas for the baseline file and the zone inventory file.
// Core module: no Node-only API here, so a Worker can run it.
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** The conditions a baseline rule or setting can carry. */
export const WHEN_VALUES = ['always', 'geo', 'no_api_hosts', 'no_hosts', 'canonical_host'] as const;
export const When = z.enum(WHEN_VALUES);
export type When = z.infer<typeof When>;

/** The placeholders a baseline expression template can use. */
export const PLACEHOLDERS = [
  'unless_api',
  'unless_wordpress',
  'exempt',
  'asns',
  'probe_paths',
  'geo_country',
  'rate_requests',
  'source_host',
  'target_host',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const Hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, 'must be a lower-case hostname');

// A probe path value goes inside a quoted string in a rule expression, so it cannot hold a quote or a backslash.
const PathValue = z.string().min(1).regex(/^[^"\\]+$/, 'must not contain a double quote or a backslash');

export const ProbePath = z.union([
  z.strictObject({ contains: PathValue }),
  z.strictObject({ ends_with: PathValue }),
  z.strictObject({ starts_with: PathValue }),
]);
export type ProbePath = z.infer<typeof ProbePath>;

const RateLimitTemplate = z.strictObject({
  characteristics: z.array(z.string().min(1)).min(1),
  period: z.number().int().positive(),
  requests_per_period: z.union([z.number().int().positive(), z.literal('{{rate_requests}}')]),
  mitigation_timeout: z.number().int().nonnegative(),
});

export const RuleTemplate = z.strictObject({
  ref: z.string().regex(/^flarewall_[a-z0-9_]+$/, 'must start with flarewall_ and use a-z, 0-9, _'),
  description: z.string().min(1),
  action: z.string().min(1),
  expression: z.string().min(1),
  enabled: z.boolean().default(true),
  when: When.default('always'),
  action_parameters: z.record(z.string(), z.unknown()).optional(),
  ratelimit: RateLimitTemplate.optional(),
});
export type RuleTemplate = z.infer<typeof RuleTemplate>;

const Requests = z.number().int().positive();

export const Baseline = z
  .strictObject({
    version: z.literal(1),
    rate_limit: z.strictObject({ requests: Requests }),
    hosting_asns: z.array(z.number().int().positive()).min(1),
    probe_paths: z.array(ProbePath).min(1),
    rules: z.strictObject({
      http_request_firewall_custom: z.array(RuleTemplate).default([]),
      http_ratelimit: z.array(RuleTemplate).default([]),
      http_request_dynamic_redirect: z.array(RuleTemplate).default([]),
    }),
    settings: z.strictObject({
      always_use_https: z.strictObject({ value: z.literal('on') }),
      browser_check: z.strictObject({ value: z.literal('on'), when: When }),
    }),
    bot_management: z.strictObject({
      fight_mode: z.literal(true),
      enable_js: z.literal(true),
      when: When,
    }),
  })
  .superRefine((baseline, ctx) => {
    const seen = new Set<string>();
    for (const rules of Object.values(baseline.rules)) {
      for (const rule of rules) {
        if (seen.has(rule.ref)) {
          ctx.addIssue({ code: 'custom', message: `duplicate rule ref ${rule.ref}`, path: ['rules'] });
        }
        seen.add(rule.ref);
      }
    }
  });
export type Baseline = z.infer<typeof Baseline>;

export const RedirectMode = z.enum(['root', 'www', 'https', 'skip']);
export type RedirectMode = z.infer<typeof RedirectMode>;

export const Inventory = z
  .strictObject({
    version: z.literal(1),
    zone: Hostname,
    zone_id: z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32 character hex zone ID'),
    hosts: z
      .strictObject({
        api: z.array(Hostname).default([]),
        wordpress: z.array(Hostname).default([]),
      })
      .default({ api: [], wordpress: [] }),
    geo: z
      .strictObject({
        enabled: z.boolean(),
        country: z.string().regex(/^[A-Z]{2}$/, 'must be a two-letter upper-case country code').optional(),
      })
      .refine((geo) => !geo.enabled || geo.country !== undefined, {
        message: 'geo.country is required when geo is enabled',
        path: ['country'],
      })
      .optional(),
    redirects: RedirectMode,
    rate_limit: z.strictObject({ requests: Requests }).optional(),
  })
  .superRefine((inventory, ctx) => {
    for (const host of inventory.hosts.wordpress) {
      if (inventory.hosts.api.includes(host)) {
        ctx.addIssue({
          code: 'custom',
          message: `${host} cannot be both an API host and a WordPress host`,
          path: ['hosts'],
        });
      }
    }
  });
export type Inventory = z.infer<typeof Inventory>;

export class SchemaError extends Error {
  constructor(what: string, detail: string) {
    super(`invalid ${what}:\n${detail}`);
    this.name = 'SchemaError';
  }
}

function parseWith<T extends z.ZodType>(schema: T, what: string, text: string): z.infer<T> {
  const result = schema.safeParse(parseYaml(text));
  if (!result.success) throw new SchemaError(what, z.prettifyError(result.error));
  return result.data;
}

/** Parses and validates baseline YAML text. Throws SchemaError on a bad file. */
export function parseBaseline(text: string): Baseline {
  return parseWith(Baseline, 'baseline', text);
}

/** Parses and validates zone inventory YAML text. Throws SchemaError on a bad file. */
export function parseInventory(text: string): Inventory {
  return parseWith(Inventory, 'inventory', text);
}
