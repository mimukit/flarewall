// The TUI state and its pure reducer: update(state, event) => { state, effects }.
// Events are key presses and data events. Effects are requests (load, refresh a zone, quit) that
// the runner in main.tsx carries out; their results come back as data events. No I/O here.
import { applyOutcomeText, planLines, zoneDiffLines, type DiffLine } from '../cli/format.js';
import type { ApplyResult, ZonePlan } from '../core/apply.js';
import type { ZoneSummary } from '../core/api.js';
import type { ZoneState } from '../core/diff.js';
import type { Baseline, Inventory } from '../core/schema.js';
import type { ZoneReport } from '../core/status.js';
import { isPrefix, lookup, type Action, type Scope } from './keymap.js';

export type Focus = 'zones' | 'diff';

/**
 * The input mode: `confirm` is the y/N prompt of one write zone, `running` means API calls are in
 * flight (a dry run, a write, or an add). The help overlay is the separate `help` flag, so it can open over any mode.
 */
export type Mode = { kind: 'normal' } | { kind: 'filter' } | { kind: 'confirm'; zone: string } | { kind: 'running' };

/** A dry run (`d`) or a write (`a`) over a list of zones, one zone at a time. */
export interface RunState {
  write: boolean;
  /** Every zone the run covers, in order; `(i of n)` counts them. */
  zones: string[];
  /** The index in `zones` of the zone in flight. */
  index: number;
  /** Set by `esc` or `ctrl-c`: no zone after the current one starts. */
  stop: boolean;
  /** Set by `ctrl-c`: quit when the current zone ends. */
  quit: boolean;
}

export const STATE_FILTERS = ['all', 'problems', 'drift', 'legacy', 'error', 'not managed'] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export const SORTS = ['zone', 'state', 'plan', 'changes'] as const;
export type Sort = (typeof SORTS)[number];

/** The last good data from the data store. */
export interface TuiData {
  baseline: Baseline;
  inventories: Inventory[];
}

/** A diff pane line. A zone card line has a label, which the screen shows dim before the text. */
export interface PaneLine extends DiffLine {
  label?: string;
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
  /** Where the data store lives, for the footer. */
  dbPath: string;
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
  /** The step of a full load in flight: reading the data store, or listing the zones. Absent when neither runs. */
  loading?: 'data' | 'zones';
  /** A load or parse error for the header, as `revision <id> (<document>): <error>`. */
  error?: string;
  /** Marked zone names. A mark stays when a filter hides its zone. */
  marks: string[];
  /** The run in flight, if any. */
  run?: RunState;
  /** The dry run or write text per zone. It shows in the diff pane until the next `r` or `R`. */
  runLines: Record<string, string[]>;
  /** The add in flight: the zones it writes an inventory entry for, and the result lines so far. */
  adding?: { zones: string[]; lines: Record<string, string[]>; quit: boolean };
  /** True once a write in this session failed; the TUI then exits 2. */
  writeFailed: boolean;
}

/**
 * Requests the runner carries out. `gen` ties the answers to the load that asked for them.
 * `apply-zone` runs applyInventoryZone on one zone; `confirm-answer` answers its y/N prompt.
 * `add-zones` writes an inventory entry for each zone, one after another, as `flarewall add` does.
 */
export type Effect =
  | { kind: 'load'; gen: number }
  | { kind: 'refresh-zone'; gen: number; zone: string; data: TuiData }
  | { kind: 'apply-zone'; zone: string; write: boolean; data: TuiData }
  | { kind: 'confirm-answer'; yes: boolean }
  | { kind: 'add-zones'; zones: string[] }
  | { kind: 'quit' };

export type TuiEvent =
  | { type: 'start' }
  /** `key` is a key name from the key map; `text` is the typed text, for printable keys. */
  | { type: 'key'; key: string; text?: string }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'data-loaded'; gen: number; data: TuiData }
  | { type: 'zones-listed'; gen: number; zones: ZoneSummary[] }
  | { type: 'report'; gen: number; report: ZoneReport }
  | { type: 'load-failed'; gen: number; error: string }
  /** The answers of an `apply-zone` effect, in the order applyZone produces them. */
  | { type: 'plan-ready'; zone: string; plan: ZonePlan }
  | { type: 'confirm-asked'; zone: string }
  | { type: 'backup-written'; zone: string; name: string }
  | { type: 'zone-done'; zone: string; outcome: ApplyResult['outcome'] }
  | { type: 'zone-failed'; zone: string; error: string }
  /** The answers of an `add-zones` effect: one per zone, then `adds-done`. */
  | { type: 'zone-added'; zone: string; revision: string }
  | { type: 'add-failed'; zone: string; error: string }
  | { type: 'adds-done' };

export interface Update {
  state: TuiState;
  effects: Effect[];
}

export function initialState(options: { dbPath: string; columns: number; rows: number }): TuiState {
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
    marks: [],
    runLines: {},
    writeFailed: false,
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

/**
 * The rows the list shows: the name filter and the state filter applied, in the sort order. A zone
 * with run text stays in view under any state filter, so its outcome and backup path do not vanish
 * when the zone shows `loading` after a write.
 */
export function visibleRows(state: TuiState): Row[] {
  const text = state.filterText.toLowerCase();
  return state.zones
    .filter((r) => r.zone.toLowerCase().includes(text) && (state.runLines[r.zone] !== undefined || matchesState(r, state.stateFilter)))
    .sort(COMPARE[state.sort]);
}

export function selectedRow(state: TuiState): Row | undefined {
  return state.zones.find((r) => r.zone === state.selected);
}

/**
 * Lines inside a pane border: the terminal less the top bars (three lines), the two pane border
 * lines, the footer box (the summary line and the hint line in a border, four lines), and the
 * error line when there is one.
 */
export function bodyHeight(state: TuiState): number {
  return Math.max(1, state.rows - 9 - (state.error === undefined ? 0 : 1));
}

/** Zone rows that fit under the column header. */
export function listHeight(state: TuiState): number {
  return Math.max(1, bodyHeight(state) - 1);
}

function halfPage(state: TuiState): number {
  return Math.max(1, Math.floor(bodyHeight(state) / 2));
}

export const LIST_HEADERS = ['ZONE', 'PLAN', 'STATE', 'CHANGES', 'UNOWNED', 'HOSTS', 'GEO', 'REDIRECT'] as const;

/** The list columns that hold a count. They align right, so the digits line up. */
export const NUMBER_COLUMNS: readonly number[] = [3, 4, 5];

/** The list column of each sort, which carries the sort arrow. */
const SORT_COLUMN: Readonly<Record<Sort, number>> = { zone: 0, plan: 1, state: 2, changes: 3 };

/** The column headers, with `↓` after the column the list is sorted on. */
export function listHeaders(state: TuiState): string[] {
  return LIST_HEADERS.map((h, i) => (i === SORT_COLUMN[state.sort] ? `${h} ↓` : h));
}

/** A mark before each state word. The word stays, so the mark and the colour are never the only signal. */
const STATE_GLYPH: Readonly<Record<string, string>> = {
  'in sync': '✓',
  drift: '▲',
  legacy: '◆',
  error: '✗',
  'not managed': '○',
  loading: '…',
};

/** The STATE cell text: the mark, then the state word. */
export function stateLabel(word: string): string {
  const glyph = STATE_GLYPH[word];
  return glyph === undefined ? word : `${glyph} ${word}`;
}

/** The short plan name for the list, as in the sketch: `Free Website` shows as `free`. */
export function planLabel(plan: string): string {
  return plan.replace(/\s+website$/i, '').trim().toLowerCase();
}

/** The header counts, in state order. `not managed` and `loading` show only when a zone has them. */
export function headerCounts(state: TuiState): { word: string; count: number }[] {
  const count = (word: string) => state.zones.filter((r) => stateWord(r) === word).length;
  return ['in sync', 'drift', 'legacy', 'error', 'not managed', 'loading']
    .map((word) => ({ word, count: count(word) }))
    .filter((c) => c.count > 0 || !['not managed', 'loading'].includes(c.word));
}

/** The eight list cells of a row. Inventory cells draw at once; report cells wait for the report. */
export function rowCells(row: Row): string[] {
  const inv = row.inventory;
  const diff = row.report?.diff;
  const count = (n: number | undefined) => (n === undefined ? '-' : String(n));
  return [
    row.zone,
    planLabel(row.report?.plan || row.plan) || '-',
    stateLabel(stateWord(row)),
    count(diff?.changes.length),
    count(diff?.unowned.length),
    inv === undefined ? '-' : String(inv.hosts.api.length + inv.hosts.wordpress.length),
    inv === undefined ? '-' : inv.geo?.enabled === true ? (inv.geo.country ?? '-') : 'off',
    inv === undefined ? '-' : inv.redirects,
  ];
}

/** The width of each list column over the header and every row. Each sortable header keeps room for its arrow, so the list does not move when the sort changes. */
export function columnWidths(state: TuiState): number[] {
  const headers = LIST_HEADERS.map((h, i) => (Object.values(SORT_COLUMN).includes(i) ? `${h} ↓` : h));
  const rows = [headers, ...state.zones.map(rowCells)];
  return LIST_HEADERS.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
}

/** The width of the zone list pane: the marker, the columns with two-space gaps, the padding, and the border. */
export function listWidth(state: TuiState): number {
  const widths = columnWidths(state);
  return 2 + widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1) + 2 + 2;
}

/** The narrowest diff pane, border included, that the two-pane layout keeps. */
export const MIN_DIFF_WIDTH = 50;

/** The share of the window the zones pane takes in the two-pane layout. */
export const ZONES_PANE_SHARE = 0.75;

/**
 * The zones pane width in the two-pane layout: 75% of the window, but never narrower than the list
 * and never so wide that the diff pane drops under MIN_DIFF_WIDTH.
 */
export function zonesPaneWidth(state: TuiState): number {
  return Math.max(listWidth(state), Math.min(Math.floor(state.columns * ZONES_PANE_SHARE), state.columns - MIN_DIFF_WIDTH));
}

/** True when the terminal cannot fit the list beside a diff pane, so one pane shows at a time. */
export function isNarrow(state: TuiState): boolean {
  return state.columns < listWidth(state) + MIN_DIFF_WIDTH;
}

/** The header text for the marks, such as `2 marked, 1 hidden`; undefined with no mark. */
export function markSummary(state: TuiState): string | undefined {
  if (state.marks.length === 0) return undefined;
  const visible = new Set(visibleRows(state).map((r) => r.zone));
  const hidden = state.marks.filter((z) => !visible.has(z)).length;
  return hidden === 0 ? `${state.marks.length} marked` : `${state.marks.length} marked, ${hidden} hidden`;
}

/** The exit code on quit: 2 when a write in the session failed, else 0. */
export function tuiExitCode(state: TuiState): number {
  return state.writeFailed ? 2 : 0;
}

/** The y/N prompt for one write zone, the same question the CLI asks. */
export function confirmPrompt(zone: string): string {
  return `Apply the baseline to ${zone}? [y/N]`;
}

/** The width of the label column in the zone card. */
export const CARD_LABEL_WIDTH = 11;

/**
 * The zone card at the top of the diff pane: the facts of the selected zone, one per line.
 * The inventory lines show only for a zone with an inventory entry.
 */
export function zoneCard(row: Row): PaneLine[] {
  const plan = planLabel(row.report?.plan || row.plan);
  const lines: PaneLine[] = [
    ...(plan === '' ? [] : [{ label: 'Plan', text: plan }]),
    ...(row.zoneId === undefined ? [] : [{ label: 'Zone ID', text: row.zoneId }]),
  ];
  const inv = row.inventory;
  if (inv !== undefined) {
    const hosts = (list: readonly string[]) => (list.length === 0 ? '-' : list.join(', '));
    lines.push(
      { label: 'API hosts', text: hosts(inv.hosts.api) },
      { label: 'WP hosts', text: hosts(inv.hosts.wordpress) },
      { label: 'Geo', text: inv.geo?.enabled === true ? `block outside ${inv.geo.country ?? '-'}` : 'off' },
      { label: 'Redirect', text: inv.redirects },
      ...(inv.rate_limit === undefined ? [] : [{ label: 'Rate limit', text: `${inv.rate_limit.requests} requests (zone override)` }]),
    );
  }
  return lines.length === 0 ? [] : [...lines, { text: '' }];
}

/**
 * The text in an empty zone list: what the load is doing, or why no row shows. Undefined when a
 * row shows. `busy` is true while a load step runs, so the screen draws a spinner before the text.
 */
export function listNotice(state: TuiState): { text: string; busy: boolean } | undefined {
  if (visibleRows(state).length > 0) return undefined;
  if (state.loading === 'data') return { text: `Reading the database at ${state.dbPath}`, busy: true };
  if (state.loading === 'zones') return { text: 'Listing the zones the token can see on Cloudflare', busy: true };
  if (state.zones.length > 0) return { text: 'No zone matches the search or the state filter.', busy: false };
  if (state.error !== undefined) return { text: 'No zone loaded. Fix the error above, then press R.', busy: false };
  return { text: 'The token sees no zone.', busy: false };
}

/** The diff pane title: the zone, and `plan (i of n)` while the zone has run text. */
export function diffPaneTitle(state: TuiState): string {
  const row = selectedRow(state);
  if (row === undefined) return state.loading === undefined ? 'No zone' : 'Loading';
  if (state.runLines[row.zone] === undefined) return row.zone;
  const run = state.run;
  const at = run === undefined ? -1 : run.zones.indexOf(row.zone);
  return run === undefined || at === -1 ? `${row.zone} plan` : `${row.zone} plan (${at + 1} of ${run.zones.length})`;
}

/**
 * The diff pane text of the selected zone: its dry run or write text when it has one (with the
 * prompt in CONFIRM), else its diff. An error zone shows its error text.
 */
export function diffPaneLines(state: TuiState): PaneLine[] {
  const row = selectedRow(state);
  if (row === undefined) return [];
  const run = state.runLines[row.zone];
  if (run !== undefined) {
    const prompt = state.mode.kind === 'confirm' && state.mode.zone === row.zone ? [confirmPrompt(row.zone)] : [];
    return [...run, ...prompt].map((text) => ({ text }));
  }
  const card = zoneCard(row);
  if (row.report === undefined) return [...card, { text: `${row.zone}: loading` }];
  if (row.inventory === undefined || row.report.state === 'not managed') return [...card, ...notManagedLines(state, row.zone)];
  const lines = zoneDiffLines(row.report, { foreign: state.showForeign, values: state.showValues });
  // The pane title already shows the zone and its state, so drop the line that only repeats them.
  const body = lines[0]?.text === `${row.zone}: ${row.report.state}` ? lines.slice(1) : lines;
  return [...card, ...(body.length === 0 ? [{ text: 'No changes.' }] : body)];
}

/** The diff pane of a `not managed` zone: the next step, and the empty state when no zone is managed. */
function notManagedLines(state: TuiState, zone: string): DiffLine[] {
  const lines = ['No inventory entry for this zone.', `Press + to add it, as flarewall add ${zone} does.`];
  if (state.zones.every((r) => r.inventory === undefined)) {
    lines.push('', `No zone has an inventory entry: 0 of ${state.zones.length} zones are managed.`, 'Mark the zones you want to manage with space, then press +.');
  }
  return lines.map((text) => ({ text }));
}

function maxScroll(state: TuiState): number {
  return Math.max(0, diffPaneLines(state).length - bodyHeight(state));
}

/** The scopes a key is looked up in, mode first. */
export function scopes(state: TuiState): Scope[] {
  if (state.help) return ['any'];
  if (state.mode.kind === 'filter') return ['filter', 'any'];
  if (state.mode.kind === 'confirm') return ['confirm', 'any'];
  if (state.mode.kind === 'running') return ['running', 'any'];
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

/** Drops a row's report, so it shows `loading`, and asks the runner to read the zone again. */
function refreshZone(state: TuiState, zone: string): Update {
  if (state.data === undefined) return none(state);
  const zones = state.zones.map((r) => {
    if (r.zone !== zone) return r;
    const { report: _drop, ...loading } = r;
    return loading;
  });
  return { state: { ...state, zones }, effects: [{ kind: 'refresh-zone', gen: state.gen, zone, data: state.data }] };
}

function withoutRunLines(state: TuiState, zone?: string): TuiState {
  if (zone === undefined) return { ...state, runLines: {} };
  const { [zone]: _drop, ...rest } = state.runLines;
  return { ...state, runLines: rest };
}

function refreshSelected(state: TuiState): Update {
  const row = selectedRow(state);
  if (row === undefined || state.data === undefined) return none(state);
  return refreshZone(withoutRunLines(state, row.zone), row.zone);
}

function load(state: TuiState): Update {
  const gen = state.gen + 1;
  return { state: { ...withoutRunLines(state), gen, loading: 'data' }, effects: [{ kind: 'load', gen }] };
}

// ---- Dry run and write ----

function toggleMark(state: TuiState): TuiState {
  const zone = state.selected;
  if (zone === undefined) return state;
  return { ...state, marks: state.marks.includes(zone) ? state.marks.filter((z) => z !== zone) : [...state.marks, zone] };
}

function markAll(state: TuiState): TuiState {
  const add = visibleRows(state).map((r) => r.zone).filter((z) => !state.marks.includes(z));
  return { ...state, marks: [...state.marks, ...add] };
}

/** The zones `d` or `a` act on: the visible marked zones in list order, else the selected zone. */
function runTargets(state: TuiState): string[] {
  if (state.focus === 'diff' || state.marks.length === 0) return state.selected === undefined ? [] : [state.selected];
  return visibleRows(state).map((r) => r.zone).filter((z) => state.marks.includes(z));
}

/** True when `d` or `a` has at least one zone to run; the hint line dims both keys when not. */
export function canRun(state: TuiState): boolean {
  return runTargets(state).some((zone) => skipLine(state.zones.find((r) => r.zone === zone), zone) === undefined);
}

/** Why a zone is skipped: no inventory entry, or an error state. Undefined when it can run. */
function skipLine(row: Row | undefined, zone: string): string | undefined {
  if (row?.inventory === undefined || row.report?.state === 'not managed') return `${zone}: skipped, not managed; press + to add it`;
  if (row.report?.state === 'error') return `${zone}: skipped: ${row.report.error ?? ''}`;
  return undefined;
}

// ---- Add ----

function isUnmanaged(row: Row | undefined): boolean {
  return row !== undefined && (row.inventory === undefined || row.report?.state === 'not managed');
}

/** The zones `+` adds: the run targets with no inventory entry. */
function addTargets(state: TuiState): string[] {
  return runTargets(state).filter((zone) => isUnmanaged(state.zones.find((r) => r.zone === zone)));
}

/** True when `+` has at least one zone to add; the hint line dims the key when not. */
export function canAdd(state: TuiState): boolean {
  return addTargets(state).length > 0;
}

function startAdd(state: TuiState): Update {
  if (state.mode.kind !== 'normal') return none(state);
  const zones = addTargets(state);
  if (zones.length === 0) return none(state);
  const focus = isNarrow(state) ? 'diff' : state.focus;
  return { state: { ...state, focus, mode: { kind: 'running' }, adding: { zones, lines: {}, quit: false } }, effects: [{ kind: 'add-zones', zones }] };
}

function onAdded(state: TuiState, zone: string, line: string): TuiState {
  const adding = state.adding;
  if (adding === undefined || !adding.zones.includes(zone)) return state;
  return setLines({ ...state, adding: { ...adding, lines: { ...adding.lines, [zone]: [line] } } }, zone, [line]);
}

/** Every add ended: reload, so the new entries show as managed zones, and keep each zone's result line. */
function onAddsDone(state: TuiState): Update {
  const adding = state.adding;
  if (adding === undefined) return none(state);
  const { adding: _done, ...rest } = state;
  if (adding.quit) return { state: { ...rest, mode: { kind: 'normal' } }, effects: [{ kind: 'quit' }] };
  const reloaded = load({ ...rest, mode: { kind: 'normal' } });
  return { state: { ...reloaded.state, runLines: adding.lines }, effects: reloaded.effects };
}

function setLines(state: TuiState, zone: string, lines: string[]): TuiState {
  return { ...state, runLines: { ...state.runLines, [zone]: lines } };
}

function addLine(state: TuiState, zone: string, line: string): TuiState {
  return setLines(state, zone, [...(state.runLines[zone] ?? []), line]);
}

/**
 * Starts the zone at `run.index` or the next one that can run; skipped zones get their skip line.
 * With no zone left (or after a stop), the run ends, and a `ctrl-c` during the run quits.
 */
function advance(state: TuiState, run: RunState, effects: Effect[]): Update {
  let next = state;
  for (let i = run.index; !run.stop && i < run.zones.length; i += 1) {
    const zone = run.zones[i] as string;
    const row = next.zones.find((r) => r.zone === zone);
    const skip = skipLine(row, zone);
    if (skip !== undefined) {
      next = setLines(next, zone, [skip]);
      continue;
    }
    if (next.data === undefined) break;
    next = { ...withoutRunLines(next, zone), run: { ...run, index: i }, mode: { kind: 'running' } };
    next = settle({ ...next, selected: zone, diffScroll: next.selected === zone ? next.diffScroll : 0 });
    return { state: next, effects: [...effects, { kind: 'apply-zone', zone, write: run.write, data: next.data as TuiData }] };
  }
  const { run: _done, ...rest } = next;
  return { state: { ...rest, mode: { kind: 'normal' } }, effects: run.quit ? [...effects, { kind: 'quit' }] : effects };
}

function startRun(state: TuiState, write: boolean): Update {
  if (state.mode.kind !== 'normal' || state.data === undefined) return none(state);
  const zones = runTargets(state);
  if (zones.length === 0) return none(state);
  const focus = isNarrow(state) ? 'diff' : state.focus;
  return advance({ ...state, focus }, { write, zones, index: 0, stop: false, quit: false }, []);
}

/** Answers the open prompt. `stop` skips the zones after this one; `quit` also quits after it. */
function answer(state: TuiState, yes: boolean, stop: boolean, quit: boolean): Update {
  const run = state.run;
  if (state.mode.kind !== 'confirm' || run === undefined) return none(state);
  const next: RunState = { ...run, stop: run.stop || stop, quit: run.quit || quit };
  return { state: { ...state, run: next, mode: { kind: 'running' } }, effects: [{ kind: 'confirm-answer', yes }] };
}

/** The outcome line. The CLI's dry run line names `--write`; the TUI names its own key. */
export function outcomeText(outcome: ApplyResult['outcome']): string {
  return outcome === 'dry run' ? 'dry run, nothing sent; press a to apply' : applyOutcomeText(outcome);
}

/** The current zone ended: show its outcome, refresh it after a write, then go on. */
function onZoneEnd(state: TuiState, event: Extract<TuiEvent, { type: 'zone-done' | 'zone-failed' }>): Update {
  const run = state.run;
  if (run === undefined || run.zones[run.index] !== event.zone) return none(state);
  const done = { ...run, index: run.index + 1 };
  if (event.type === 'zone-failed') {
    let next = addLine(state, event.zone, `${event.zone}: error: ${event.error}`);
    next = {
      ...next,
      writeFailed: state.writeFailed || run.write,
      zones: next.zones.map((r) => (r.zone === event.zone ? { ...r, report: { zone: r.zone, plan: r.plan, state: 'error', error: event.error, ...(r.zoneId === undefined ? {} : { zoneId: r.zoneId }) } } : r)),
    };
    return advance(next, done, []);
  }
  const next = addLine(state, event.zone, `${event.zone}: ${outcomeText(event.outcome)}`);
  if (run.write && event.outcome === 'applied') {
    const refreshed = refreshZone(next, event.zone);
    return advance(refreshed.state, done, refreshed.effects);
  }
  return advance(next, done, []);
}

function act(state: TuiState, action: Action): Update {
  const diff = state.focus === 'diff' && state.mode.kind === 'normal';
  switch (action) {
    case 'help':
      return none({ ...state, help: !state.help });
    case 'quit':
      if (state.mode.kind === 'confirm') return answer(state, false, true, true);
      if (state.run !== undefined) return none({ ...state, run: { ...state.run, stop: true, quit: true } });
      // An add in flight writes its files first, as a write finishes its zone first.
      if (state.adding !== undefined) return none({ ...state, adding: { ...state.adding, quit: true } });
      return { state, effects: [{ kind: 'quit' }] };
    case 'cancel':
      if (state.help) return none({ ...state, help: false });
      if (state.run !== undefined) return none({ ...state, run: { ...state.run, stop: true } });
      // An add is one file per zone and ends at once; esc does not stop it.
      if (state.adding !== undefined) return none(state);
      return none({ ...state, mode: { kind: 'normal' } });
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
    case 'mark':
      return none(toggleMark(state));
    case 'mark-all':
      return none(markAll(state));
    case 'clear-marks':
      return none({ ...state, marks: [] });
    case 'add':
      return startAdd(state);
    case 'dry-run':
      return startRun(state, false);
    case 'apply':
      return startRun(state, true);
    case 'confirm-yes':
      return answer(state, true, false, false);
    case 'confirm-no':
      return answer(state, false, false, false);
    case 'confirm-stop':
      return answer(state, false, true, false);
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

/** A failed load: the error goes to the top line, and each row still waiting for a report shows the error, so `d` and `a` skip it. */
function onLoadFailed(state: TuiState, error: string): TuiState {
  const zones = state.zones.map((r) => (r.report !== undefined ? r : { ...r, report: { zone: r.zone, plan: r.plan, state: 'error' as const, error, ...(r.zoneId === undefined ? {} : { zoneId: r.zoneId }) } }));
  return settle({ ...withoutLoading(state), zones, error });
}

function withoutLoading(state: TuiState): TuiState {
  const { loading: _done, ...rest } = state;
  return rest;
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
      const next = settle({ ...rest, loading: 'zones', data: event.data, zones: rowsFromData(state, event.data) });
      // A not managed zone has no row until the zones are listed; keep it selected until then.
      const keep = state.selected !== undefined && !next.zones.some((r) => r.zone === state.selected);
      return none(keep ? { ...next, selected: state.selected, diffScroll: state.diffScroll } : next);
    }
    case 'zones-listed':
      return none(event.gen === state.gen ? onZonesListed(withoutLoading(state), event.zones) : state);
    case 'report':
      return none(event.gen === state.gen ? onReport(state, event.report) : state);
    case 'load-failed':
      return none(event.gen === state.gen ? onLoadFailed(state, event.error) : state);
    case 'plan-ready': {
      const lines = planLines(event.plan);
      return none(state.run === undefined ? state : setLines(state, event.zone, lines));
    }
    case 'confirm-asked':
      if (state.run === undefined) return none(state);
      return none(settle({ ...state, mode: { kind: 'confirm', zone: event.zone }, selected: event.zone, help: false }));
    case 'backup-written':
      return none(state.run === undefined ? state : addLine(state, event.zone, `${event.zone}: ${event.name} saved`));
    case 'zone-done':
    case 'zone-failed':
      return onZoneEnd(state, event);
    case 'zone-added':
      return none(onAdded(state, event.zone, `${event.zone}: saved ${event.revision}; sort its hosts with flarewall edit ${event.zone}, then press R`));
    case 'add-failed':
      return none(onAdded(state, event.zone, `${event.zone}: error: ${event.error}`));
    case 'adds-done':
      return onAddsDone(state);
  }
}
