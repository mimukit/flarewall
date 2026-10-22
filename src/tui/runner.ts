// Runs the reducer's effects: reads the data store and the live zones through the core, applies
// zones through applyInventoryZone, adds zones as `flarewall add` does, and sends the answers back
// as data events. It holds no rule
// logic; statusAll and applyZone decide every state and every write.
import type { CloudflareApi } from '../core/api.js';
import { applyInventoryZone, type BackupWriter } from '../core/apply.js';
import { statusAll } from '../core/status.js';
import type { TuiData } from './state.js';
import type { EffectRunner } from './store.js';

export interface RunnerDeps {
  api: CloudflareApi;
  /** Reads the current baseline and inventory revisions. Its error message names the revision. */
  load: () => Promise<TuiData>;
  /** Stores the backup before a write: the same writer as `flarewall apply --write`. */
  backup: BackupWriter;
  /** Writes the first inventory revision for a zone and names it: the same step as `flarewall add`. */
  add: (zone: string) => Promise<string>;
  /** Called on the quit effect. */
  onQuit: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRunner(deps: RunnerDeps): EffectRunner {
  /** The answer to the open y/N prompt of the zone in flight. */
  let pendingAnswer: ((yes: boolean) => void) | undefined;

  return (effect, dispatch) => {
    switch (effect.kind) {
      case 'quit':
        deps.onQuit();
        return;
      case 'load': {
        const { gen } = effect;
        void (async () => {
          let data: TuiData;
          try {
            data = await deps.load();
          } catch (error) {
            dispatch({ type: 'load-failed', gen, error: message(error) });
            return;
          }
          dispatch({ type: 'data-loaded', gen, data });
          try {
            dispatch({ type: 'zones-listed', gen, zones: await deps.api.listZones() });
            await statusAll(deps.api, data.baseline, data.inventories, [], {
              onReport: (report) => dispatch({ type: 'report', gen, report }),
            });
          } catch (error) {
            dispatch({ type: 'load-failed', gen, error: `error: ${message(error)}` });
          }
        })();
        return;
      }
      case 'refresh-zone': {
        const { gen, zone, data } = effect;
        void statusAll(deps.api, data.baseline, data.inventories, [zone], {
          onReport: (report) => dispatch({ type: 'report', gen, report }),
        }).catch((error: unknown) => {
          dispatch({ type: 'report', gen, report: { zone, plan: '', state: 'error', error: message(error) } });
        });
        return;
      }
      case 'apply-zone': {
        const { zone, write, data } = effect;
        const inventory = data.inventories.find((i) => i.zone === zone);
        if (inventory === undefined) {
          dispatch({ type: 'zone-failed', zone, error: `no inventory entry; run flarewall add ${zone}` });
          return;
        }
        const backup: BackupWriter = async (name, state) => {
          const path = await deps.backup(name, state);
          dispatch({ type: 'backup-written', zone, name: path });
          return path;
        };
        const confirm = () =>
          new Promise<boolean>((resolve) => {
            pendingAnswer = resolve;
            dispatch({ type: 'confirm-asked', zone });
          });
        void applyInventoryZone(deps.api, data.baseline, inventory, {
          write,
          backup,
          onPlan: (plan) => dispatch({ type: 'plan-ready', zone, plan }),
          ...(write ? { confirm } : {}),
        }).then(
          (result) => dispatch({ type: 'zone-done', zone, outcome: result.outcome }),
          (error: unknown) => dispatch({ type: 'zone-failed', zone, error: message(error) }),
        );
        return;
      }
      case 'add-zones': {
        void (async () => {
          for (const zone of effect.zones) {
            try {
              dispatch({ type: 'zone-added', zone, revision: await deps.add(zone) });
            } catch (error) {
              dispatch({ type: 'add-failed', zone, error: message(error) });
            }
          }
          dispatch({ type: 'adds-done' });
        })();
        return;
      }
      case 'confirm-answer': {
        const resolve = pendingAnswer;
        pendingAnswer = undefined;
        resolve?.(effect.yes);
        return;
      }
    }
  };
}
