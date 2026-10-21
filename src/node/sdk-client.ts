// CloudflareApi over the official `cloudflare` SDK. Kept thin: no logic beyond shape mapping.
import Cloudflare, { NotFoundError } from 'cloudflare';
import type { BotManagementState, CloudflareApi, LiveRule, SettingId, ZoneSummary } from '../core/api.js';
import type { DnsRecord, Phase } from '../core/render.js';

interface SdkZone {
  id: string;
  name: string;
  account: { id?: string };
  plan: { name?: string };
}

function summary(zone: SdkZone): ZoneSummary {
  return { id: zone.id, name: zone.name, accountId: zone.account.id ?? '', plan: zone.plan.name ?? '' };
}

function botState(value: unknown): BotManagementState {
  const v = value as { fight_mode?: boolean; enable_js?: boolean };
  const state: BotManagementState = {};
  if (v.fight_mode !== undefined) state.fight_mode = v.fight_mode;
  if (v.enable_js !== undefined) state.enable_js = v.enable_js;
  return state;
}

export function createSdkClient(apiToken: string): CloudflareApi {
  const client = new Cloudflare({ apiToken, maxRetries: 5 });
  return {
    async listZones() {
      const zones: ZoneSummary[] = [];
      for await (const zone of client.zones.list()) zones.push(summary(zone));
      return zones;
    },
    async getZone(zoneId) {
      return summary(await client.zones.get({ zone_id: zoneId }));
    },
    async listDnsRecords(zoneId) {
      const records: DnsRecord[] = [];
      for await (const r of client.dns.records.list({ zone_id: zoneId })) {
        records.push({ name: r.name, type: r.type, content: String(r.content ?? ''), proxied: r.proxied === true });
      }
      return records;
    },
    async getPhase(zoneId, phase: Phase) {
      try {
        const ruleset = await client.rulesets.phases.get(phase, { zone_id: zoneId });
        return (ruleset.rules ?? []) as unknown as LiveRule[];
      } catch (error) {
        if (error instanceof NotFoundError) return [];
        throw error;
      }
    },
    async updatePhase(zoneId, phase: Phase, rules) {
      const ruleset = (await client.rulesets.phases.update(phase, {
        zone_id: zoneId,
        rules: rules as never,
      })) as unknown as { rules?: LiveRule[] } | null;
      return ruleset?.rules ?? [];
    },
    async getSetting(zoneId, id: SettingId) {
      const setting = await client.zones.settings.get(id, { zone_id: zoneId });
      return (setting as { value?: unknown }).value;
    },
    async editSetting(zoneId, id: SettingId, value) {
      const setting = await client.zones.settings.edit(id, { zone_id: zoneId, value });
      return (setting as { value?: unknown }).value;
    },
    async getBotManagement(zoneId) {
      return botState(await client.botManagement.get({ zone_id: zoneId }));
    },
    async updateBotManagement(zoneId, state) {
      return botState(await client.botManagement.update({ zone_id: zoneId, ...state }));
    },
  };
}
