// CloudflareApi: the only door from the core to Cloudflare. The Node CLI implements it over the
// `cloudflare` SDK (src/node/sdk-client.ts); tests implement it in memory (test/fake-api.ts).
// Core module: no Node-only API here, so a Worker can run it.
import type { DnsRecord, Phase } from './render.js';

/** A zone as the token sees it. */
export interface ZoneSummary {
  id: string;
  name: string;
  accountId: string;
  /** The plan name, such as `Free Website`. */
  plan: string;
}

/** A rule as Cloudflare returns it. Only the allowlisted fields matter to flarewall. */
export interface LiveRule {
  id?: string;
  ref?: string;
  description?: string;
  action?: string;
  expression?: string;
  enabled?: boolean;
  action_parameters?: unknown;
  ratelimit?: unknown;
  [field: string]: unknown;
}

/** The zone setting IDs flarewall reads and writes. */
export type SettingId = 'always_use_https' | 'browser_check';

/** Bot Fight Mode, as flarewall reads and writes it. */
export interface BotManagementState {
  fight_mode?: boolean;
  enable_js?: boolean;
}

export interface CloudflareApi {
  /** Every zone the token can see. */
  listZones(): Promise<ZoneSummary[]>;
  getZone(zoneId: string): Promise<ZoneSummary>;
  listDnsRecords(zoneId: string): Promise<DnsRecord[]>;
  /** The rules of the zone's entry point ruleset for the phase; [] when the zone has none (a 404). */
  getPhase(zoneId: string, phase: Phase): Promise<LiveRule[]>;
  /** Replaces the rules of the zone's entry point ruleset for the phase and returns the new rules. */
  updatePhase(zoneId: string, phase: Phase, rules: LiveRule[]): Promise<LiveRule[]>;
  /** The setting's `value`, such as `on` or `off`. */
  getSetting(zoneId: string, id: SettingId): Promise<unknown>;
  editSetting(zoneId: string, id: SettingId, value: unknown): Promise<unknown>;
  getBotManagement(zoneId: string): Promise<BotManagementState>;
  updateBotManagement(zoneId: string, state: { fight_mode: boolean; enable_js: boolean }): Promise<BotManagementState>;
}
