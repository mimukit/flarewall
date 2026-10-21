// Starts the TUI: builds the store and the runner, then renders the app on the alternate screen.
// Only `flarewall tui` loads this module, with a dynamic import, so no other command loads Ink.
import { render } from 'ink';
import type { ReactElement } from 'react';
import type { CloudflareApi } from '../core/api.js';
import { createBackupWriter } from '../node/backup.js';
import { addZone, loadData } from '../node/data.js';
import { App } from './app.js';
import { createRunner } from './runner.js';
import { initialState, tuiExitCode, type TuiData } from './state.js';
import { createStore, type Store } from './store.js';

export interface TuiOptions {
  api: CloudflareApi;
  dataDir: string;
  /** Reads the data repo. Default: loadData. */
  load?: (dataDir: string) => Promise<TuiData>;
  /** The terminal width at start; the app follows resizes after that. */
  columns: number;
  /** A fixed terminal height. Default: the terminal height, followed on resize. */
  rows?: number;
  /** The clock for backup directory names. Default: the system clock. */
  now?: () => Date;
  onQuit: () => void;
}

/** The store and the app element. Tests render the element with ink-testing-library. */
export function createTui(options: TuiOptions): { store: Store; element: ReactElement } {
  const store = createStore(
    initialState({ dataDir: options.dataDir, columns: options.columns, rows: options.rows ?? 24 }),
    createRunner({
      api: options.api,
      dataDir: options.dataDir,
      load: options.load ?? loadData,
      backup: createBackupWriter(options.dataDir, options.now),
      add: (zone) => addZone(options.api, options.dataDir, zone),
      onQuit: options.onQuit,
    }),
  );
  return { store, element: <App store={store} {...(options.rows === undefined ? {} : { rows: options.rows })} /> };
}

/** Runs the TUI until the owner quits, then exits the process: 2 when a write failed, else 0. */
export async function startTui(options: { api: CloudflareApi; dataDir: string }): Promise<never> {
  let quit = () => {};
  const { store, element } = createTui({ ...options, columns: process.stdout.columns ?? 80, onQuit: () => quit() });
  const instance = render(element, { exitOnCtrlC: false, alternateScreen: true });
  quit = () => instance.unmount();
  await instance.waitUntilExit();
  // A load or a refresh still in flight would keep Node running after the screen closes. No write
  // is in flight here: a quit waits for the zone being written, and for an add, to end.
  process.exit(tuiExitCode(store.getState()));
}
