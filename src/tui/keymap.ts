// The TUI key table. The reducer looks keys up here, and the help overlay renders from it,
// so the help and the keys stay the same.

/** Where a binding applies. `any` applies in every mode, after the mode's own bindings. */
export type Scope = 'any' | 'zones' | 'diff' | 'filter';

export type Action =
  | 'help'
  | 'quit'
  | 'cancel'
  | 'down'
  | 'up'
  | 'top'
  | 'bottom'
  | 'half-down'
  | 'half-up'
  | 'next-problem'
  | 'prev-problem'
  | 'focus-diff'
  | 'focus-zones'
  | 'filter'
  | 'next-match'
  | 'prev-match'
  | 'cycle-state-filter'
  | 'cycle-sort'
  | 'refresh'
  | 'reload'
  | 'next-section'
  | 'prev-section'
  | 'toggle-foreign'
  | 'toggle-values'
  | 'filter-keep'
  | 'filter-clear'
  | 'filter-delete-char'
  | 'filter-delete-word'
  | 'filter-delete-all'
  | 'filter-text';

export interface Binding {
  scope: Scope;
  /**
   * Key names as the app sends them: a printed character (`j`, `G`, `?`), a sequence (`gg`),
   * or a named key (`down`, `enter`, `esc`, `tab`, `shift-tab`, `backspace`, `ctrl-d`).
   * An empty list means typed text.
   */
  keys: readonly string[];
  action: Action;
  /** The help overlay text. */
  help: string;
  /** The short form for the key hint line; absent keeps the binding out of the line. */
  hint?: string;
}

export const SCOPE_TITLES: Readonly<Record<Scope, string>> = {
  any: 'Any mode',
  zones: 'NORMAL, zones pane',
  diff: 'NORMAL, diff pane',
  filter: 'FILTER',
};

export const KEYMAP: readonly Binding[] = [
  { scope: 'any', keys: ['?'], action: 'help', help: 'Open or close the help overlay', hint: '? help' },
  { scope: 'any', keys: ['ctrl-c'], action: 'quit', help: 'Quit' },
  { scope: 'any', keys: ['esc'], action: 'cancel', help: 'Cancel the current mode and go back to NORMAL' },

  { scope: 'zones', keys: ['j', 'down'], action: 'down', help: 'Select the next zone', hint: 'j/k move' },
  { scope: 'zones', keys: ['k', 'up'], action: 'up', help: 'Select the previous zone' },
  { scope: 'zones', keys: ['gg'], action: 'top', help: 'Select the first zone' },
  { scope: 'zones', keys: ['G'], action: 'bottom', help: 'Select the last zone' },
  { scope: 'zones', keys: ['ctrl-d'], action: 'half-down', help: 'Move half a page down' },
  { scope: 'zones', keys: ['ctrl-u'], action: 'half-up', help: 'Move half a page up' },
  { scope: 'zones', keys: [']'], action: 'next-problem', help: 'Select the next zone in drift, legacy, or error', hint: ']/[ next problem' },
  { scope: 'zones', keys: ['['], action: 'prev-problem', help: 'Select the previous zone in drift, legacy, or error' },
  { scope: 'zones', keys: ['l', 'tab', 'enter'], action: 'focus-diff', help: 'Focus the diff pane', hint: 'l diff' },
  { scope: 'zones', keys: ['/'], action: 'filter', help: 'Enter FILTER mode to filter zones by name', hint: '/ filter' },
  { scope: 'zones', keys: ['n'], action: 'next-match', help: 'Select the next filter match' },
  { scope: 'zones', keys: ['N'], action: 'prev-match', help: 'Select the previous filter match' },
  { scope: 'zones', keys: ['f'], action: 'cycle-state-filter', help: 'Cycle the state filter: all, problems, drift, legacy, error, not managed', hint: 'f state' },
  { scope: 'zones', keys: ['s'], action: 'cycle-sort', help: 'Cycle the sort: zone, state, plan, changes', hint: 's sort' },
  { scope: 'zones', keys: ['r'], action: 'refresh', help: 'Refresh the selected zone', hint: 'r refresh' },
  { scope: 'zones', keys: ['R'], action: 'reload', help: 'Reload baseline.yaml, the inventory, and every zone', hint: 'R reload' },
  { scope: 'zones', keys: ['q'], action: 'quit', help: 'Quit', hint: 'q quit' },

  { scope: 'diff', keys: ['j', 'down'], action: 'down', help: 'Scroll one line down', hint: 'j/k scroll' },
  { scope: 'diff', keys: ['k', 'up'], action: 'up', help: 'Scroll one line up' },
  { scope: 'diff', keys: ['ctrl-d'], action: 'half-down', help: 'Scroll half a page down' },
  { scope: 'diff', keys: ['ctrl-u'], action: 'half-up', help: 'Scroll half a page up' },
  { scope: 'diff', keys: ['gg'], action: 'top', help: 'Go to the top' },
  { scope: 'diff', keys: ['G'], action: 'bottom', help: 'Go to the bottom' },
  { scope: 'diff', keys: ['}'], action: 'next-section', help: 'Go to the next section: one phase, settings, bot management', hint: '}/{ section' },
  { scope: 'diff', keys: ['{'], action: 'prev-section', help: 'Go to the previous section' },
  { scope: 'diff', keys: ['z'], action: 'toggle-foreign', help: 'Show or hide the unowned and legacy rules', hint: 'z unowned' },
  { scope: 'diff', keys: ['e'], action: 'toggle-values', help: 'Show or hide the live and wanted values of each changed field', hint: 'e values' },
  { scope: 'diff', keys: ['h', 'shift-tab', 'esc', 'tab'], action: 'focus-zones', help: 'Focus the zones pane', hint: 'h zones' },
  { scope: 'diff', keys: ['r'], action: 'refresh', help: 'Refresh the selected zone', hint: 'r refresh' },

  { scope: 'filter', keys: [], action: 'filter-text', help: 'Type text to narrow the list on each key press', hint: 'type to filter' },
  { scope: 'filter', keys: ['enter'], action: 'filter-keep', help: 'Keep the filter and go back to NORMAL', hint: 'enter keep' },
  { scope: 'filter', keys: ['esc'], action: 'filter-clear', help: 'Clear the filter and go back to NORMAL', hint: 'esc clear' },
  { scope: 'filter', keys: ['backspace'], action: 'filter-delete-char', help: 'Delete one character' },
  { scope: 'filter', keys: ['ctrl-w'], action: 'filter-delete-word', help: 'Delete a word', hint: 'ctrl-w word' },
  { scope: 'filter', keys: ['ctrl-u'], action: 'filter-delete-all', help: 'Delete the whole filter', hint: 'ctrl-u all' },
];

/** The first binding for `key` in the scopes, in scope order. */
export function lookup(scopes: readonly Scope[], key: string): Binding | undefined {
  for (const scope of scopes) {
    const found = KEYMAP.find((b) => b.scope === scope && b.keys.includes(key));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A key sequence repeats one character, such as `gg`. A named key (`down`, `ctrl-d`) is not one. */
function isSequence(key: string): boolean {
  return key.length > 1 && [...key].every((c) => c === key[0]);
}

/** Whether `seq` starts a longer key sequence (such as `g` for `gg`) in the scopes. */
export function isPrefix(scopes: readonly Scope[], seq: string): boolean {
  return KEYMAP.some((b) => scopes.includes(b.scope) && b.keys.some((k) => isSequence(k) && k.length > seq.length && k.startsWith(seq)));
}

/** The hint line for the scopes: each hinted binding of the mode's scope, then the `any` ones. */
export function hints(scopes: readonly Scope[]): string[] {
  return scopes.flatMap((scope) => KEYMAP.filter((b) => b.scope === scope && b.hint !== undefined).map((b) => b.hint as string));
}
