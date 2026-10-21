// Runs the reducer's effects: reads the data repo and the live zones through the core, and sends
// the answers back as data events. It holds no rule logic; statusAll decides every state.
import type { CloudflareApi } from '../core/api.js';
import { statusAll } from '../core/status.js';
import type { TuiData } from './state.js';
import type { EffectRunner } from './store.js';

export interface RunnerDeps {
  api: CloudflareApi;
  dataDir: string;
  /** Reads baseline.yaml and the inventory. Its error message names the file: `<file>: <error>`. */
  load: (dataDir: string) => Promise<TuiData>;
  /** Called on the quit effect. */
  onQuit: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRunner(deps: RunnerDeps): EffectRunner {
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
            data = await deps.load(deps.dataDir);
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
    }
  };
}
