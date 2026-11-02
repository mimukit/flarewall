// Starts the TUI: builds the store and the runner, then renders the app on the alternate screen.
// Only `flarewall tui` loads this module, with a dynamic import, so no other command loads Ink.
import { render } from 'ink';
import type { ReactElement } from 'react';
import type { CloudflareApi } from '../core/api.js';
import { addZoneInventory, loadDataSet, storeBackupWriter } from '../core/revisions.js';
import type { DataStore } from '../core/store.js';
import { App } from './app.js';
import { createRunner } from './runner.js';
import { initialState, tuiExitCode, type TuiData } from './state.js';
import { createStore, type Store } from './store.js';

export interface TuiOptions {
  api: CloudflareApi;
  store: DataStore;
  /** Reads the current revisions. Default: loadDataSet on the store. */
  load?: () => Promise<TuiData>;
  /** The terminal width at start; the app follows resizes after that. */
  columns: number;
  /** A fixed terminal height. Default: the terminal height, followed on resize. */
  rows?: number;
  onQuit: () => void;
}

/** The store and the app element. Tests render the element with ink-testing-library. */
export function createTui(options: TuiOptions): { store: Store; element: ReactElement } {
  const store = createStore(
    initialState({ dbPath: options.store.location, columns: options.columns, rows: options.rows ?? 24 }),
    createRunner({
      api: options.api,
      load: options.load ?? (() => loadDataSet(options.store)),
      backup: storeBackupWriter(options.store),
      add: async (zone) => `inventory revision ${(await addZoneInventory(options.api, options.store, zone)).id}`,
      onQuit: options.onQuit,
    }),
  );
  return { store, element: <App store={store} {...(options.rows === undefined ? {} : { rows: options.rows })} /> };
}

/** Runs the TUI until the owner quits, then exits the process: 2 when a write failed, else 0. */
export async function startTui(options: { api: CloudflareApi; store: DataStore }): Promise<never> {
  let quit = () => {};
  const { store, element } = createTui({ ...options, columns: process.stdout.columns ?? 80, onQuit: () => quit() });
  const instance = render(element, { exitOnCtrlC: false, alternateScreen: true });
  quit = () => instance.unmount();
  await instance.waitUntilExit();
  // A load or a refresh still in flight would keep Node running after the screen closes. No write
  // is in flight here: a quit waits for the zone being written, and for an add, to end.
  process.exit(tuiExitCode(store.getState()));
}
