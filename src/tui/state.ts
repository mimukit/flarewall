// The TUI state and its pure reducer: update(state, event) => { state, effects }.
// Events are key presses and data events. Effects are requests (load, refresh a zone, quit) that
// the runner in main.tsx carries out; their results come back as data events. No I/O here.
import { zoneDiffLines, type DiffLine } from '../cli/format.js';
import type { ZoneSummary } from '../core/api.js';
import type { ZoneState } from '../core/diff.js';
import type { Baseline, Inventory } from '../core/schema.js';
import type { ZoneReport } from '../core/status.js';
import { isPrefix, lookup, type Action, type Scope } from './keymap.js';

export type Focus = 'zones' | 'diff';

/**
 * The input mode. Phase 3 adds `confirm` (one y/N prompt per write zone) and `running` (API
 * calls in flight) as new kinds here; the help overlay is the separate `help` flag, so it can
 * open over any mode.
 */
export type Mode = { kind: 'normal' } | { kind: 'filter' };

export const STATE_FILTERS = ['all', 'problems', 'drift', 'legacy', 'error', 'not managed'] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export const SORTS = ['zone', 'state', 'plan', 'changes'] as const;
export type Sort = (typeof SORTS)[number];

/** The last good data from the data repo. */
export interface TuiData {
  baseline: Baseline;
  inventories: Inventory[];
}

/** One zone row. A row with no report is still loading. */
export interface Row {
  zone: string;
  zoneId?: string;
  /** The plan from listZones; empty until the zones are listed. */
  plan: string;
  /** Absent for a zone the token sees that has no inventory entry. */
  inventory?: Inventory;
  report?: ZoneReport;
}

export interface TuiState {
  dataDir: string;
  columns: number;
  rows: number;
  /** Bumped by each full load. Data events from an earlier generation are dropped. */
  gen: number;
  data?: TuiData;
  zones: Row[];
  selected?: string;
  /** The first visible row of the zone list. */
  listTop: number;
  focus: Focus;
  mode: Mode;
  help: boolean;
  filterText: string;
  stateFilter: StateFilter;
  sort: Sort;
  diffScroll: number;
  showForeign: boolean;
  showValues: boolean;
  /** The first keys of a sequence such as `gg`. */
  pending: string;
  /** A load or parse error for the header, as `<file>: <error>`. */
  error?: string;
}

/**
 * Requests the runner carries out. `gen` ties the answers to the load that asked for them.
 * Phase 3 adds dry-run and apply effects here.
 */
export type Effect =
  | { kind: 'load'; gen: number }
  | { kind: 'refresh-zone'; gen: number; zone: string; data: TuiData }
  | { kind: 'quit' };

export type TuiEvent =
  | { type: 'start' }
  /** `key` is a key name from the key map; `text` is the typed text, for printable keys. */
  | { type: 'key'; key: string; text?: string }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'data-loaded'; gen: number; data: TuiData }
  | { type: 'zones-listed'; gen: number; zones: ZoneSummary[] }
  | { type: 'report'; gen: number; report: ZoneReport }
  | { type: 'load-failed'; gen: number; error: string };

export interface Update {
  state: TuiState;
  effects: Effect[];
}

export function initialState(options: { dataDir: string; columns: number; rows: number }): TuiState {
  return {
    ...options,
    gen: 0,
    zones: [],
    listTop: 0,
    focus: 'zones',
    mode: { kind: 'normal' },
    help: false,
    filterText: '',
    stateFilter: 'all',
    sort: 'zone',
    diffScroll: 0,
    showForeign: true,
    showValues: false,
    pending: '',
  };
}

// ---- Derived views, shared by the reducer and the screen ----

/** The STATE word of a row: the report state, or `loading`. */
export function stateWord(row: Row): ZoneState | 'loading' {
  return row.report?.state ?? 'loading';
}

const PROBLEMS: readonly string[] = ['drift', 'legacy', 'error'];
const STATE_ORDER: readonly string[] = ['error', 'drift', 'legacy', 'not managed', 'in sync', 'loading'];

function changeCount(row: Row): number {
  return row.report?.diff?.changes.length ?? -1;
}

function byZone(a: Row, b: Row): number {
  return a.zone.localeCompare(b.zone);
}

const COMPARE: Readonly<Record<Sort, (a: Row, b: Row) => number>> = {
  zone: byZone,
  state: (a, b) => STATE_ORDER.indexOf(stateWord(a)) - STATE_ORDER.indexOf(stateWord(b)) || byZone(a, b),
  plan: (a, b) => a.plan.localeCompare(b.plan) || byZone(a, b),
  changes: (a, b) => changeCount(b) - changeCount(a) || byZone(a, b),
};

function matchesState(row: Row, filter: StateFilter): boolean {
  if (filter === 'all') return true;
  const word = stateWord(row);
  return filter === 'problems' ? PROBLEMS.includes(word) : word === filter;
}

/** The rows the list shows: the name filter and the state filter applied, in the sort order. */
export function visibleRows(state: TuiState): Row[] {
  const text = state.filterText.toLowerCase();
  return state.zones
    .filter((r) => r.zone.toLowerCase().includes(text) && matchesState(r, state.stateFilter))
    .sort(COMPARE[state.sort]);
}

export function selectedRow(state: TuiState): Row | undefined {
  return state.zones.find((r) => r.zone === state.selected);
}

/** Lines inside a pane border: the terminal less the header (and its error line), two border lines, and the hint line. */
export function bodyHeight(state: TuiState): number {
  return Math.max(1, state.rows - 4 - (state.error === undefined ? 0 : 1));
}

/** Zone rows that fit under the column header. */
export function listHeight(state: TuiState): number {
  return Math.max(1, bodyHeight(state) - 1);
}

function halfPage(state: TuiState): number {
  return Math.max(1, Math.floor(bodyHeight(state) / 2));
}

export const LIST_HEADERS = ['ZONE', 'PLAN', 'STATE', 'CHANGES', 'UNOWNED', 'HOSTS', 'GEO', 'REDIRECT'] as const;

/** The eight list cells of a row. Inventory cells draw at once; report cells wait for the report. */
export function rowCells(row: Row): string[] {
  const inv = row.inventory;
  const diff = row.report?.diff;
  const count = (n: number | undefined) => (n === undefined ? '-' : String(n));
  return [
    row.zone,
    row.report?.plan || row.plan || '-',
    stateWord(row),
    count(diff?.changes.length),
    count(diff?.unowned.length),
    inv === undefined ? '-' : String(inv.hosts.api.length + inv.hosts.wordpress.length),
    inv === undefined ? '-' : inv.geo?.enabled === true ? (inv.geo.country ?? '-') : 'off',
    inv === undefined ? '-' : inv.redirects,
  ];
}

/** The width of each list column over the header and every row. */
export function columnWidths(state: TuiState): number[] {
  const rows = [[...LIST_HEADERS], ...state.zones.map(rowCells)];
  return LIST_HEADERS.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
}

/** The width of the zone list pane: the marker, the columns with two-space gaps, and the border. */
export function listWidth(state: TuiState): number {
  const widths = columnWidths(state);
  return 2 + widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1) + 2;
}

/** The narrowest diff pane, border included, that the two-pane layout keeps. */
export const MIN_DIFF_WIDTH = 50;

/** True when the terminal cannot fit the list beside a diff pane, so one pane shows at a time. */
export function isNarrow(state: TuiState): boolean {
  return state.columns < listWidth(state) + MIN_DIFF_WIDTH;
}

/** The diff pane text of the selected zone. An error zone shows its error text. */
export function diffPaneLines(state: TuiState): DiffLine[] {
  const row = selectedRow(state);
  if (row === undefined) return [];
  if (row.report === undefined) return [{ text: `${row.zone}: loading` }];
  return zoneDiffLines(row.report, { foreign: state.showForeign, values: state.showValues });
}

function maxScroll(state: TuiState): number {
  return Math.max(0, diffPaneLines(state).length - bodyHeight(state));
}

/** The scopes a key is looked up in, mode first. */
export function scopes(state: TuiState): Scope[] {
  if (state.help) return ['any'];
  if (state.mode.kind === 'filter') return ['filter', 'any'];
  return [state.focus, 'any'];
}

/** The scopes the hint line names: `any` first, so `? help` stays in view on a narrow line. */
export function hintScopes(state: TuiState): Scope[] {
  return ['any', ...scopes(state).filter((s) => s !== 'any')];
}

// ---- The reducer ----

const none = (state: TuiState): Update => ({ state, effects: [] });

/** Keeps the selection on a visible row and the list window around it. */
function settle(state: TuiState): TuiState {
  const rows = visibleRows(state);
  let selected = state.selected;
  if (!rows.some((r) => r.zone === selected)) selected = rows[0]?.zone;
  const index = Math.max(0, rows.findIndex((r) => r.zone === selected));
  const height = listHeight(state);
  let top = Math.min(state.listTop, Math.max(0, rows.length - height));
  if (index < top) top = index;
  if (index >= top + height) top = index - height + 1;
  const next = { ...state, listTop: Math.max(0, top) };
  return selected === state.selected ? next : { ...next, selected, diffScroll: 0 };
}

/** Selects the visible row at `index`, clamped to the list. */
function selectIndex(state: TuiState, index: number): TuiState {
  const rows = visibleRows(state);
  const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
  if (row === undefined || row.zone === state.selected) return state;
  return settle({ ...state, selected: row.zone, diffScroll: 0 });
}

function selectedIndex(state: TuiState): number {
  return visibleRows(state).findIndex((r) => r.zone === state.selected);
}

/** Selects the next (step 1) or previous (step -1) visible row that passes `test`, if any. */
function selectWhere(state: TuiState, step: 1 | -1, test: (row: Row) => boolean, wrap: boolean): TuiState {
  const rows = visibleRows(state);
  const from = selectedIndex(state);
  for (let i = 1; i <= rows.length; i += 1) {
    const at = from + step * i;
    if (!wrap && (at < 0 || at >= rows.length)) break;
    const row = rows[(at + rows.length) % rows.length];
    if (row !== undefined && test(row)) return selectIndex(state, (at + rows.length) % rows.length);
  }
  return state;
}

function scrollTo(state: TuiState, line: number): TuiState {
  return { ...state, diffScroll: Math.max(0, Math.min(maxScroll(state), line)) };
}

/** Scrolls to the next (1) or previous (-1) line that starts a new section. */
function scrollSection(state: TuiState, step: 1 | -1): TuiState {
  const lines = diffPaneLines(state);
  const starts = lines.flatMap((l, i) => (l.section !== undefined && l.section !== lines[i - 1]?.section ? [i] : []));
  const target = step === 1 ? starts.find((i) => i > state.diffScroll) : starts.filter((i) => i < state.diffScroll).at(-1);
  return target === undefined ? state : scrollTo(state, target);
}

function cycle<T>(values: readonly T[], value: T): T {
  return values[(values.indexOf(value) + 1) % values.length] as T;
}

function setFilter(state: TuiState, filterText: string): TuiState {
  return settle({ ...state, filterText, listTop: 0 });
}

function refreshSelected(state: TuiState): Update {
  const row = selectedRow(state);
  if (row === undefined || state.data === undefined) return none(state);
  const { report: _drop, ...loading } = row;
  const zones = state.zones.map((r) => (r === row ? loading : r));
  return { state: { ...state, zones }, effects: [{ kind: 'refresh-zone', gen: state.gen, zone: row.zone, data: state.data }] };
}

function load(state: TuiState): Update {
  const gen = state.gen + 1;
  return { state: { ...state, gen }, effects: [{ kind: 'load', gen }] };
}

function act(state: TuiState, action: Action): Update {
  const diff = state.focus === 'diff' && state.mode.kind === 'normal';
  switch (action) {
    case 'help':
      return none({ ...state, help: !state.help });
    case 'quit':
      return { state, effects: [{ kind: 'quit' }] };
    case 'cancel':
      return none(state.help ? { ...state, help: false } : { ...state, mode: { kind: 'normal' } });
    case 'down':
      return none(diff ? scrollTo(state, state.diffScroll + 1) : selectIndex(state, selectedIndex(state) + 1));
    case 'up':
      return none(diff ? scrollTo(state, state.diffScroll - 1) : selectIndex(state, selectedIndex(state) - 1));
    case 'top':
      return none(diff ? scrollTo(state, 0) : selectIndex(state, 0));
    case 'bottom':
      return none(diff ? scrollTo(state, maxScroll(state)) : selectIndex(state, visibleRows(state).length - 1));
    case 'half-down':
      return none(diff ? scrollTo(state, state.diffScroll + halfPage(state)) : selectIndex(state, selectedIndex(state) + halfPage(state)));
    case 'half-up':
      return none(diff ? scrollTo(state, state.diffScroll - halfPage(state)) : selectIndex(state, selectedIndex(state) - halfPage(state)));
    case 'next-problem':
      return none(selectWhere(state, 1, (r) => PROBLEMS.includes(stateWord(r)), false));
    case 'prev-problem':
      return none(selectWhere(state, -1, (r) => PROBLEMS.includes(stateWord(r)), false));
    case 'focus-diff':
      return none({ ...state, focus: 'diff' });
    case 'focus-zones':
      return none({ ...state, focus: 'zones' });
    case 'filter':
      return none({ ...state, mode: { kind: 'filter' } });
    case 'next-match':
    case 'prev-match': {
      const text = state.filterText.toLowerCase();
      if (text === '') return none(state);
      return none(selectWhere(state, action === 'next-match' ? 1 : -1, (r) => r.zone.toLowerCase().includes(text), true));
    }
    case 'cycle-state-filter':
      return none(settle({ ...state, stateFilter: cycle(STATE_FILTERS, state.stateFilter), listTop: 0 }));
    case 'cycle-sort':
      return none(settle({ ...state, sort: cycle(SORTS, state.sort) }));
    case 'refresh':
      return refreshSelected(state);
    case 'reload':
      return load(state);
    case 'next-section':
      return none(scrollSection(state, 1));
    case 'prev-section':
      return none(scrollSection(state, -1));
    case 'toggle-foreign':
      return none(scrollTo({ ...state, showForeign: !state.showForeign }, state.diffScroll));
    case 'toggle-values':
      return none(scrollTo({ ...state, showValues: !state.showValues }, state.diffScroll));
    case 'filter-keep':
      return none({ ...state, mode: { kind: 'normal' } });
    case 'filter-clear':
      return none(setFilter({ ...state, mode: { kind: 'normal' } }, ''));
    case 'filter-delete-char':
      return none(setFilter(state, state.filterText.slice(0, -1)));
    case 'filter-delete-word':
      // A word ends at a space, dot, dash, or underscore; trailing separators go with the word before them.
      return none(setFilter(state, state.filterText.replace(/[^\s._-]*[\s._-]*$/, '')));
    case 'filter-delete-all':
      return none(setFilter(state, ''));
    case 'filter-text':
      return none(state);
  }
}

function onKey(state: TuiState, key: string, text: string | undefined): Update {
  const where = scopes(state);
  const seq = state.pending + key;
  const exact = lookup(where, seq);
  if (exact !== undefined) return act({ ...state, pending: '' }, exact.action);
  if (state.mode.kind !== 'filter' && !state.help && isPrefix(where, seq)) return none({ ...state, pending: seq });
  const cleared = { ...state, pending: '' };
  const single = state.pending === '' ? undefined : lookup(where, key);
  if (single !== undefined) return act(cleared, single.action);
  if (state.mode.kind === 'filter' && !state.help && text !== undefined && text !== '') {
    return none(setFilter(cleared, state.filterText + text));
  }
  return none(cleared);
}

/** Builds the rows from a fresh data set; plans carry over by zone so the list does not jump. */
function rowsFromData(state: TuiState, data: TuiData): Row[] {
  const plans = new Map(state.zones.map((r) => [r.zone, r.plan]));
  return data.inventories.map((inventory) => ({
    zone: inventory.zone,
    zoneId: inventory.zone_id,
    plan: plans.get(inventory.zone) ?? '',
    inventory,
  }));
}

function onZonesListed(state: TuiState, zones: ZoneSummary[]): TuiState {
  const rows = state.zones.map((r) => {
    const zone = zones.find((z) => z.id === r.zoneId || z.name === r.zone);
    return zone === undefined ? r : { ...r, plan: zone.plan };
  });
  for (const zone of zones) {
    if (!rows.some((r) => r.zoneId === zone.id || r.zone === zone.name)) rows.push({ zone: zone.name, zoneId: zone.id, plan: zone.plan });
  }
  return settle({ ...state, zones: rows });
}

function onReport(state: TuiState, report: ZoneReport): TuiState {
  const found = state.zones.some((r) => r.zone === report.zone);
  const zones = found
    ? state.zones.map((r) => (r.zone === report.zone ? { ...r, plan: report.plan || r.plan, report } : r))
    : [...state.zones, { zone: report.zone, plan: report.plan, report, ...(report.zoneId === undefined ? {} : { zoneId: report.zoneId }) }];
  const next = { ...state, zones };
  return settle(report.zone === state.selected ? scrollTo(next, state.diffScroll) : next);
}

export function update(state: TuiState, event: TuiEvent): Update {
  switch (event.type) {
    case 'start':
      return load(state);
    case 'key':
      return onKey(state, event.key, event.text);
    case 'resize':
      return none(settle({ ...state, columns: event.columns, rows: event.rows }));
    case 'data-loaded': {
      if (event.gen !== state.gen) return none(state);
      const { error: _drop, ...rest } = state;
      return none(settle({ ...rest, data: event.data, zones: rowsFromData(state, event.data) }));
    }
    case 'zones-listed':
      return none(event.gen === state.gen ? onZonesListed(state, event.zones) : state);
    case 'report':
      return none(event.gen === state.gen ? onReport(state, event.report) : state);
    case 'load-failed':
      return none(event.gen === state.gen ? { ...state, error: event.error } : state);
  }
}
