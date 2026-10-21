// The TUI key table. The reducer looks keys up here, and the help overlay renders from it,
// so the help and the keys stay the same.

/** Where a binding applies. `any` applies in every mode, after the mode's own bindings. */
export type Scope = 'any' | 'zones' | 'diff' | 'filter' | 'confirm' | 'running';

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
  | 'filter-text'
  | 'mark'
  | 'mark-all'
  | 'clear-marks'
  | 'add'
  | 'dry-run'
  | 'apply'
  | 'confirm-yes'
  | 'confirm-no'
  | 'confirm-stop';

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
  confirm: 'CONFIRM, one prompt per zone',
  running: 'RUNNING, while API calls run',
};

export const KEYMAP: readonly Binding[] = [
  { scope: 'any', keys: ['?'], action: 'help', help: 'Open or close the help overlay', hint: '? help' },
  { scope: 'any', keys: ['ctrl-c'], action: 'quit', help: 'Quit. During a write, the current zone finishes first' },
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
  { scope: 'zones', keys: ['space'], action: 'mark', help: 'Mark or unmark the selected zone', hint: 'space mark' },
  { scope: 'zones', keys: ['ctrl-a'], action: 'mark-all', help: 'Mark all visible zones' },
  { scope: 'zones', keys: ['ctrl-x'], action: 'clear-marks', help: 'Clear every mark' },
  { scope: 'zones', keys: ['+'], action: 'add', help: 'Write an inventory entry for each marked not managed zone, or the selected one, as flarewall add does, then reload', hint: '+ add' },
  { scope: 'zones', keys: ['d'], action: 'dry-run', help: 'Dry run on the marked zones, or the selected zone. The plan shows in the diff pane', hint: 'd dry run' },
  { scope: 'zones', keys: ['a'], action: 'apply', help: 'Write on the marked zones, or the selected zone. Opens CONFIRM once per zone', hint: 'a apply' },
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
  { scope: 'diff', keys: ['+'], action: 'add', help: 'Write an inventory entry for the selected zone when it is not managed, then reload', hint: '+ add' },
  { scope: 'diff', keys: ['d'], action: 'dry-run', help: 'Dry run on the selected zone', hint: 'd dry run' },
  { scope: 'diff', keys: ['a'], action: 'apply', help: 'Write on the selected zone. Opens CONFIRM', hint: 'a apply' },
  { scope: 'diff', keys: ['r'], action: 'refresh', help: 'Refresh the selected zone', hint: 'r refresh' },

  { scope: 'filter', keys: [], action: 'filter-text', help: 'Type text to narrow the list on each key press', hint: 'type to filter' },
  { scope: 'filter', keys: ['enter'], action: 'filter-keep', help: 'Keep the filter and go back to NORMAL', hint: 'enter keep' },
  { scope: 'filter', keys: ['esc'], action: 'filter-clear', help: 'Clear the filter and go back to NORMAL', hint: 'esc clear' },
  { scope: 'filter', keys: ['backspace'], action: 'filter-delete-char', help: 'Delete one character' },
  { scope: 'filter', keys: ['ctrl-w'], action: 'filter-delete-word', help: 'Delete a word', hint: 'ctrl-w word' },
  { scope: 'filter', keys: ['ctrl-u'], action: 'filter-delete-all', help: 'Delete the whole filter', hint: 'ctrl-u all' },

  { scope: 'confirm', keys: ['y'], action: 'confirm-yes', help: 'Back up, write, and read back this zone, then go to the next zone', hint: 'y apply this zone' },
  { scope: 'confirm', keys: ['n', 'enter'], action: 'confirm-no', help: 'Skip this zone. The default is no', hint: 'n skip this zone' },
  { scope: 'confirm', keys: ['esc'], action: 'confirm-stop', help: 'Stop the run and skip the remaining zones', hint: 'esc stop, skip the rest' },

  { scope: 'running', keys: ['j', 'down'], action: 'down', help: 'Select the next zone; +, d, a, r, and R wait until the run ends', hint: 'j/k move' },
  { scope: 'running', keys: ['k', 'up'], action: 'up', help: 'Select the previous zone' },
  { scope: 'running', keys: ['esc'], action: 'cancel', help: 'Skip the remaining zones after the current one', hint: 'esc stop after this zone' },
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

/** The hinted bindings for the scopes, in scope order, so the hint line can style one by its action. */
export function hintBindings(scopes: readonly Scope[]): Binding[] {
  return scopes.flatMap((scope) => KEYMAP.filter((b) => b.scope === scope && b.hint !== undefined));
}

/** The hint line for the scopes: each hinted binding of the mode's scope, then the `any` ones. */
export function hints(scopes: readonly Scope[]): string[] {
  return hintBindings(scopes).map((b) => b.hint as string);
}
