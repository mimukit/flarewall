// An in-memory CloudflareApi. It records every write call and can fail a chosen call per zone.
import type { BotManagementState, CloudflareApi, LiveRule, SettingId, ZoneSummary } from '../src/core/api.js';
import type { DesiredZone, DnsRecord, Phase } from '../src/core/render.js';

export interface FakeZone {
  summary: ZoneSummary;
  dns: DnsRecord[];
  phases: Partial<Record<Phase, LiveRule[]>>;
  settings: Partial<Record<SettingId, unknown>>;
  botManagement: BotManagementState;
}

export type WriteCall =
  | { method: 'updatePhase'; zoneId: string; phase: Phase; rules: LiveRule[] }
  | { method: 'editSetting'; zoneId: string; id: SettingId; value: unknown }
  | { method: 'updateBotManagement'; zoneId: string; state: BotManagementState };

type Method = keyof CloudflareApi;

const clone = <T>(value: T): T => structuredClone(value);

export class FakeCloudflareApi implements CloudflareApi {
  readonly zones = new Map<string, FakeZone>();
  readonly writes: WriteCall[] = [];
  /** Calls to fail: `${method} ${zoneId}` -> error message. */
  readonly failures = new Map<string, string>();

  addZone(zone: Partial<FakeZone> & { summary: ZoneSummary }): FakeZone {
    const full: FakeZone = { dns: [], phases: {}, settings: {}, botManagement: {}, ...clone(zone) };
    this.zones.set(zone.summary.id, full);
    return full;
  }

  fail(method: Method, zoneId: string, message: string): void {
    this.failures.set(`${method} ${zoneId}`, message);
  }

  private zone(method: Method, zoneId: string): FakeZone {
    const failure = this.failures.get(`${method} ${zoneId}`);
    if (failure !== undefined) throw new Error(failure);
    const zone = this.zones.get(zoneId);
    if (zone === undefined) throw new Error(`404: no zone ${zoneId}`);
    return zone;
  }

  async listZones() {
    return [...this.zones.values()].map((z) => clone(z.summary));
  }
  async getZone(zoneId: string) {
    return clone(this.zone('getZone', zoneId).summary);
  }
  async listDnsRecords(zoneId: string) {
    return clone(this.zone('listDnsRecords', zoneId).dns);
  }
  async getPhase(zoneId: string, phase: Phase) {
    return clone(this.zone('getPhase', zoneId).phases[phase] ?? []);
  }
  async updatePhase(zoneId: string, phase: Phase, rules: LiveRule[]) {
    const zone = this.zone('updatePhase', zoneId);
    this.writes.push({ method: 'updatePhase', zoneId, phase, rules: clone(rules) });
    zone.phases[phase] = clone(rules);
    return clone(rules);
  }
  async getSetting(zoneId: string, id: SettingId) {
    return clone(this.zone('getSetting', zoneId).settings[id]);
  }
  async editSetting(zoneId: string, id: SettingId, value: unknown) {
    const zone = this.zone('editSetting', zoneId);
    this.writes.push({ method: 'editSetting', zoneId, id, value: clone(value) });
    zone.settings[id] = clone(value);
    return clone(value);
  }
  async getBotManagement(zoneId: string) {
    return clone(this.zone('getBotManagement', zoneId).botManagement);
  }
  async updateBotManagement(zoneId: string, state: { fight_mode: boolean; enable_js: boolean }) {
    const zone = this.zone('updateBotManagement', zoneId);
    this.writes.push({ method: 'updateBotManagement', zoneId, state: clone(state) });
    zone.botManagement = clone(state);
    return clone(state);
  }
}

/** The live state a zone holds right after flarewall applied `desired`: rules get ids, as Cloudflare adds them. */
export function liveFromDesired(desired: DesiredZone): Pick<FakeZone, 'phases' | 'settings' | 'botManagement'> {
  const phases: Partial<Record<Phase, LiveRule[]>> = {};
  for (const [phase, rules] of Object.entries(desired.phases) as [Phase, LiveRule[]][]) {
    phases[phase] = rules.map((r, i) => ({ id: `${phase}-${i}`, version: '1', last_updated: '2026-10-21T00:00:00Z', ...clone(r) }));
  }
  return {
    phases,
    settings: { ...desired.settings },
    botManagement: desired.botManagement ? { ...desired.botManagement } : { fight_mode: false, enable_js: false },
  };
}
