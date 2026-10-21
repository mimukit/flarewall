// The TUI reducer: one test per key map row in Phase 2 scope, plus the data events.
import { describe, expect, it } from 'vitest';
import type { Change } from '../src/core/diff.js';
import type { Phase } from '../src/core/render.js';
import { parseInventory, type Inventory } from '../src/core/schema.js';
import type { ZoneReport } from '../src/core/status.js';
import { KEYMAP } from '../src/tui/keymap.js';
import { applyOutcomeText, planLines } from '../src/cli/format.js';
import type { ZonePlan } from '../src/core/apply.js';
import { diffPaneLines, diffPaneTitle, initialState, markSummary, update, visibleRows, type Effect, type TuiData, type TuiEvent, type TuiState } from '../src/tui/state.js';
import { defaultBaseline } from './helpers.js';

const CUSTOM: Phase = 'http_request_firewall_custom';
const RATE: Phase = 'http_ratelimit';

const ID = (n: number) => n.toString(16).padStart(32, '0');

function inventory(zone: string, n: number): Inventory {
  return parseInventory(`version: 1\nzone: ${zone}\nzone_id: "${ID(n)}"\nredirects: root\n`);
}

const changed = (phase: Phase, ref: string): Change => ({ kind: 'changed', phase, ref, description: ref, fields: ['expression'] });
const missing = (phase: Phase, ref: string): Change => ({ kind: 'missing', phase, ref, description: ref });

/** b.example.net carries one section per phase, a setting and bot management, for scroll and section tests. */
const B_CHANGES: Change[] = [
  changed(CUSTOM, 'flarewall_one'),
  changed(CUSTOM, 'flarewall_two'),
  changed(CUSTOM, 'flarewall_three'),
  missing(RATE, 'flarewall_rate_one'),
  missing(RATE, 'flarewall_rate_two'),
  missing(RATE, 'flarewall_rate_three'),
  { kind: 'setting', setting: 'always_use_https', expected: 'on', actual: 'off' },
  { kind: 'bot_management', expected: { fight_mode: true, enable_js: true }, actual: { fight_mode: false } },
];

const ZONES = ['a.example.com', 'b.example.net', 'c.example.com', 'd.example.net', 'e.example.com'] as const;
const PLANS: Record<string, string> = {
  'a.example.com': 'Pro Website',
  'b.example.net': 'Free Website',
  'c.example.com': 'Free Website',
  'd.example.net': 'Business Website',
  'e.example.com': 'Free Website',
};

function reports(): ZoneReport[] {
  const base = (zone: string, n: number) => ({ zone, zoneId: ID(n), plan: PLANS[zone] ?? '' });
  return [
    { ...base('a.example.com', 1), state: 'in sync', diff: { state: 'in sync', changes: [], unowned: [], legacy: [] } },
    {
      ...base('b.example.net', 2),
      state: 'drift',
      diff: { state: 'drift', changes: B_CHANGES, unowned: [{ phase: CUSTOM, id: 'hand-1', description: 'Allow office' }], legacy: [] },
    },
    {
      ...base('c.example.com', 3),
      state: 'legacy',
      diff: { state: 'legacy', changes: [missing(CUSTOM, 'flarewall_probes')], unowned: [], legacy: [{ phase: CUSTOM, id: 'old-1', description: 'Block ports' }] },
    },
    { ...base('d.example.net', 4), state: 'error', error: 'getPhase failed: 403' },
    { ...base('e.example.com', 5), state: 'not managed' },
  ];
}

function run(state: TuiState, events: TuiEvent[]): { state: TuiState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const event of events) {
    const next = update(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const key = (k: string): TuiEvent => ({ type: 'key', key: k, ...(k.length === 1 ? { text: k } : {}) });
const press = (state: TuiState, ...keys: string[]) => run(state, keys.map(key));
const type = (state: TuiState, text: string) => run(state, [...text].map(key));

/** A state with every zone loaded and reported. rows: 6 gives a body of 2 lines, so half a page is 1. */
function loaded(size: { columns?: number; rows?: number } = {}): TuiState {
  const inventories = ZONES.filter((z) => z !== 'e.example.com').map((z, i) => inventory(z, i + 1));
  const start = run(initialState({ dataDir: '/data', columns: size.columns ?? 200, rows: size.rows ?? 30 }), [{ type: 'start' }]);
  const gen = start.state.gen;
  return run(start.state, [
    { type: 'data-loaded', gen, data: { baseline: defaultBaseline(), inventories } },
    { type: 'zones-listed', gen, zones: ZONES.map((z, i) => ({ id: ID(i + 1), name: z, accountId: ID(99), plan: PLANS[z] ?? '' })) },
    ...reports().map((report): TuiEvent => ({ type: 'report', gen, report })),
  ]).state;
}

const names = (state: TuiState) => visibleRows(state).map((r) => r.zone);
const select = (state: TuiState, zone: string): TuiState => ({ ...state, selected: zone });

describe('TUI reducer, any mode', () => {
  it('? opens and closes the help overlay', () => {
    const open = press(loaded(), '?').state;
    expect(open.help).toBe(true);
    expect(press(open, 'j').state.selected).toBe('a.example.com');
    expect(press(open, '?').state.help).toBe(false);
  });

  it('ctrl-c quits from NORMAL, FILTER, and the help overlay', () => {
    expect(press(loaded(), 'ctrl-c').effects).toEqual([{ kind: 'quit' }]);
    expect(press(loaded(), '/', 'ctrl-c').effects).toEqual([{ kind: 'quit' }]);
    expect(press(loaded(), '?', 'ctrl-c').effects).toEqual([{ kind: 'quit' }]);
  });

  it('esc closes the help overlay and leaves FILTER mode for NORMAL', () => {
    expect(press(loaded(), '?', 'esc').state.help).toBe(false);
    expect(press(loaded(), '/', 'esc').state.mode).toEqual({ kind: 'normal' });
  });
});

describe('TUI reducer, NORMAL zones pane', () => {
  it('j and down select the next zone, k and up the previous one', () => {
    let s = loaded();
    expect(s.selected).toBe('a.example.com');
    s = press(s, 'j').state;
    expect(s.selected).toBe('b.example.net');
    s = press(s, 'down').state;
    expect(s.selected).toBe('c.example.com');
    s = press(s, 'k').state;
    expect(s.selected).toBe('b.example.net');
    s = press(s, 'up', 'up').state;
    expect(s.selected).toBe('a.example.com');
  });

  it('gg selects the first zone and G the last one', () => {
    const last = press(loaded(), 'G').state;
    expect(last.selected).toBe('e.example.com');
    expect(press(last, 'g').state.selected).toBe('e.example.com');
    expect(press(last, 'g', 'g').state.selected).toBe('a.example.com');
  });

  it('ctrl-d and ctrl-u move half a page down or up', () => {
    // rows 9: a body of 5 lines, so half a page is 2 zones.
    const down = press(loaded({ rows: 9 }), 'ctrl-d').state;
    expect(down.selected).toBe('c.example.com');
    expect(press(down, 'ctrl-u').state.selected).toBe('a.example.com');
  });

  it('] and [ select the next or previous zone in drift, legacy, or error', () => {
    let s = loaded();
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      s = press(s, ']').state;
      seen.push(s.selected);
    }
    expect(seen).toEqual(['b.example.net', 'c.example.com', 'd.example.net', 'd.example.net']);
    expect(press(s, '[').state.selected).toBe('c.example.com');
  });

  it.each(['l', 'tab', 'enter'])('%s focuses the diff pane', (k) => {
    expect(press(loaded(), k).state.focus).toBe('diff');
  });

  it('/ enters FILTER mode', () => {
    expect(press(loaded(), '/').state.mode).toEqual({ kind: 'filter' });
  });

  it('n and N select the next or previous filter match', () => {
    const s = run(loaded(), [...[...'/net'].map(key), key('enter')]).state;
    expect(names(s)).toEqual(['b.example.net', 'd.example.net']);
    expect(s.selected).toBe('b.example.net');
    expect(press(s, 'n').state.selected).toBe('d.example.net');
    expect(press(s, 'n', 'n').state.selected).toBe('b.example.net');
    expect(press(s, 'N').state.selected).toBe('d.example.net');
  });

  it('f cycles the state filter: all, problems, drift, legacy, error, not managed', () => {
    let s = loaded();
    const seen: string[][] = [names(s)];
    for (let i = 0; i < 6; i += 1) {
      s = press(s, 'f').state;
      seen.push(names(s));
    }
    expect(seen).toEqual([
      [...ZONES],
      ['b.example.net', 'c.example.com', 'd.example.net'],
      ['b.example.net'],
      ['c.example.com'],
      ['d.example.net'],
      ['e.example.com'],
      [...ZONES],
    ]);
  });

  it('s cycles the sort: zone, state, plan, changes', () => {
    let s = loaded();
    const seen: string[][] = [];
    for (let i = 0; i < 4; i += 1) {
      s = press(s, 's').state;
      seen.push(names(s));
    }
    expect(seen).toEqual([
      // state: error, drift, legacy, not managed, in sync
      ['d.example.net', 'b.example.net', 'c.example.com', 'e.example.com', 'a.example.com'],
      // plan, then zone
      ['d.example.net', 'b.example.net', 'c.example.com', 'e.example.com', 'a.example.com'],
      // changes, most first; no report counts as none
      ['b.example.net', 'c.example.com', 'a.example.com', 'd.example.net', 'e.example.com'],
      [...ZONES],
    ]);
  });

  it('r refreshes the selected zone only, and its row shows loading', () => {
    const s = loaded();
    const { state, effects } = press(select(s, 'b.example.net'), 'r');
    expect(effects).toEqual([{ kind: 'refresh-zone', gen: s.gen, zone: 'b.example.net', data: s.data }]);
    expect(state.zones.find((z) => z.zone === 'b.example.net')?.report).toBeUndefined();
    expect(state.zones.find((z) => z.zone === 'a.example.com')?.report?.state).toBe('in sync');
  });

  it('R reloads the data and every zone under a new generation', () => {
    const s = loaded();
    const { state, effects } = press(s, 'R');
    expect(effects).toEqual([{ kind: 'load', gen: s.gen + 1 }]);
    expect(state.gen).toBe(s.gen + 1);
  });

  it('q quits', () => {
    expect(press(loaded(), 'q').effects).toEqual([{ kind: 'quit' }]);
  });
});

describe('TUI reducer, NORMAL diff pane', () => {
  /** b.example.net, diff pane focused, body of 2 lines. */
  const diff = () => press(select(loaded({ rows: 6 }), 'b.example.net'), 'l').state;

  it('j and k scroll one line', () => {
    const s = press(diff(), 'j', 'j').state;
    expect(s.diffScroll).toBe(2);
    expect(s.selected).toBe('b.example.net');
    expect(press(s, 'k').state.diffScroll).toBe(1);
    expect(press(s, 'k', 'k', 'k').state.diffScroll).toBe(0);
  });

  it('ctrl-d and ctrl-u scroll half a page', () => {
    // rows 8: a body of 4 lines, so half a page is 2 lines.
    const s = press(select(loaded({ rows: 8 }), 'b.example.net'), 'l', 'ctrl-d').state;
    expect(s.diffScroll).toBe(2);
    expect(press(s, 'ctrl-u').state.diffScroll).toBe(0);
  });

  it('gg and G go to the top or bottom', () => {
    const s = diff();
    const lines = diffPaneLines(s).length;
    const bottom = press(s, 'G').state;
    expect(bottom.diffScroll).toBe(lines - 2);
    expect(press(bottom, 'g', 'g').state.diffScroll).toBe(0);
  });

  it('} and { go to the next or previous section', () => {
    let s = diff();
    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      s = press(s, '}').state;
      seen.push(s.diffScroll);
    }
    const lines = diffPaneLines(s).map((l) => l.text);
    expect(lines[seen[0] ?? -1]).toMatch(/^ {2}http_request_firewall_custom: changed flarewall_one/);
    expect(lines[seen[1] ?? -1]).toMatch(/^ {2}http_ratelimit: missing flarewall_rate_one/);
    expect(lines[seen[2] ?? -1]).toMatch(/^ {2}setting always_use_https/);
    expect(press(s, '{').state.diffScroll).toBe(seen[1]);
  });

  it('z shows or hides the unowned and legacy rules', () => {
    const s = diff();
    expect(diffPaneLines(s).map((l) => l.text)).toContain('  http_request_firewall_custom: unowned "Allow office" (id hand-1)');
    const hidden = press(s, 'z').state;
    expect(diffPaneLines(hidden).map((l) => l.text).join('\n')).not.toContain('unowned');
    expect(diffPaneLines(press(hidden, 'z').state).map((l) => l.text).join('\n')).toContain('unowned');
  });

  it('e shows or hides the live and wanted values of each changed field', () => {
    const s = loaded();
    const want = { ref: 'flarewall_one', description: 'one', action: 'block', expression: '(http.host eq "a.example.com")' };
    const report: ZoneReport = {
      zone: 'a.example.com',
      zoneId: ID(1),
      plan: 'Pro Website',
      state: 'drift',
      diff: { state: 'drift', changes: [changed(CUSTOM, 'flarewall_one')], unowned: [], legacy: [] },
      detail: {
        desired: { zone: 'a.example.com', phases: { [CUSTOM]: [want] }, settings: { always_use_https: 'on' } },
        live: { phases: { [CUSTOM]: [{ ...want, expression: '(true)' }] }, settings: {} },
      },
    };
    const withDetail = run(s, [{ type: 'report', gen: s.gen, report }]).state;
    const text = (st: TuiState) => diffPaneLines(st).map((l) => l.text);
    expect(text(withDetail)).not.toContain('    expression: live "(true)"; want "(http.host eq \\"a.example.com\\")"');
    const shown = press(withDetail, 'l', 'e').state;
    expect(text(shown)).toContain('    expression: live "(true)"; want "(http.host eq \\"a.example.com\\")"');
    expect(text(press(shown, 'e').state)).toEqual(text(withDetail));
  });

  it.each(['h', 'shift-tab', 'esc', 'tab'])('%s focuses the zones pane', (k) => {
    expect(press(diff(), k).state.focus).toBe('zones');
  });

  it('r refreshes the selected zone', () => {
    const s = diff();
    expect(press(s, 'r').effects).toEqual([{ kind: 'refresh-zone', gen: s.gen, zone: 'b.example.net', data: s.data }]);
  });
});

describe('TUI reducer, FILTER', () => {
  it('text narrows the list on each key press', () => {
    let s = press(loaded(), '/').state;
    s = type(s, 'c').state;
    expect(names(s)).toEqual(['a.example.com', 'c.example.com', 'e.example.com']);
    s = type(s, '.').state;
    expect(names(s)).toEqual(['c.example.com']);
    expect(s.filterText).toBe('c.');
    expect(press(s, 'backspace').state.filterText).toBe('c');
  });

  it('typed letters go to the filter, not to the NORMAL keys', () => {
    const { state, effects } = type(press(loaded(), '/').state, 'jq');
    expect(state.filterText).toBe('jq');
    expect(state.mode).toEqual({ kind: 'filter' });
    expect(effects).toEqual([]);
  });

  it('enter keeps the filter and goes back to NORMAL', () => {
    const s = run(loaded(), [...[...'/net'].map(key), key('enter')]).state;
    expect(s.mode).toEqual({ kind: 'normal' });
    expect(s.filterText).toBe('net');
    expect(names(s)).toEqual(['b.example.net', 'd.example.net']);
  });

  it('esc clears the filter and goes back to NORMAL', () => {
    const s = run(loaded(), [...[...'/net'].map(key), key('esc')]).state;
    expect(s.mode).toEqual({ kind: 'normal' });
    expect(s.filterText).toBe('');
    expect(names(s)).toEqual([...ZONES]);
  });

  it('ctrl-w deletes a word and ctrl-u deletes the whole filter', () => {
    const s = type(press(loaded(), '/').state, 'example.net').state;
    expect(press(s, 'ctrl-w').state.filterText).toBe('example.');
    expect(press(s, 'ctrl-u').state.filterText).toBe('');
  });
});

describe('TUI reducer, data events', () => {
  it('rows show loading after the data loads and before each report', () => {
    const start = run(initialState({ dataDir: '/data', columns: 200, rows: 30 }), [{ type: 'start' }]);
    expect(start.effects).toEqual([{ kind: 'load', gen: 1 }]);
    const s = update(start.state, { type: 'data-loaded', gen: 1, data: { baseline: defaultBaseline(), inventories: [inventory('a.example.com', 1)] } }).state;
    expect(s.zones.map((z) => [z.zone, z.report])).toEqual([['a.example.com', undefined]]);
  });

  it('a failed reload keeps the earlier rows and shows the error', () => {
    const s = loaded();
    const failed = run(s, [key('R'), { type: 'load-failed', gen: s.gen + 1, error: '/data/baseline.yaml: invalid baseline' }]).state;
    expect(failed.error).toBe('/data/baseline.yaml: invalid baseline');
    expect(failed.zones).toEqual(s.zones);
    expect(failed.data).toBe(s.data);
  });

  it('ignores a report from an earlier generation', () => {
    const s = press(loaded(), 'R').state;
    const stale = update(s, { type: 'report', gen: s.gen - 1, report: { zone: 'a.example.com', plan: '', state: 'error', error: 'old' } }).state;
    expect(stale.zones.find((z) => z.zone === 'a.example.com')?.report?.state).toBe('in sync');
  });
});

describe('TUI key map', () => {
  it('names every Phase 2 key in the help table', () => {
    const keys = new Set(KEYMAP.flatMap((b) => b.keys.map((k) => `${b.scope} ${k}`)));
    for (const k of ['any ?', 'any ctrl-c', 'any esc', 'zones j', 'zones gg', 'zones ]', 'zones /', 'zones f', 'zones s', 'zones R', 'zones q', 'diff }', 'diff z', 'diff e', 'filter ctrl-w']) {
      expect(keys).toContain(k);
    }
  });
});

// ---- Phase 3: marks, dry run, write, CONFIRM, RUNNING ----

const PLAN_B: ZonePlan = {
  zone: 'b.example.net',
  phases: [],
  settings: [{ id: 'always_use_https', live: 'off', want: 'on' }],
  limitErrors: [],
  hasWrites: true,
};
const PLAN_C: ZonePlan = { ...PLAN_B, zone: 'c.example.com' };
const paneText = (state: TuiState) => diffPaneLines(state).map((l) => l.text);
const applyEffect = (state: TuiState, zone: string, write: boolean): Effect => ({ kind: 'apply-zone', zone, write, data: state.data as TuiData });
const marked = (zones: string[]) => ({ ...loaded(), marks: zones });

describe('TUI reducer, marks', () => {
  it('space marks or unmarks the selected zone', () => {
    const s = press(loaded(), 'j', 'space').state;
    expect(s.marks).toEqual(['b.example.net']);
    expect(press(s, 'space').state.marks).toEqual([]);
  });

  it('ctrl-a marks every visible zone, and ctrl-x clears every mark', () => {
    const s = run(loaded(), [...[...'/net'].map(key), key('enter'), key('ctrl-a')]).state;
    expect([...s.marks].sort()).toEqual(['b.example.net', 'd.example.net']);
    const cleared = run(s, [...[...'/'].map(key), key('esc'), key('ctrl-x')]).state;
    expect(cleared.marks).toEqual([]);
  });

  it('marks stay when a filter hides a zone, and the summary names the hidden marks', () => {
    const s = press(loaded(), 'space', 'j', 'space').state;
    expect(markSummary(s)).toBe('2 marked');
    const filtered = run(s, [...[...'/net'].map(key), key('enter')]).state;
    expect(filtered.marks).toEqual(['a.example.com', 'b.example.net']);
    expect(markSummary(filtered)).toBe('2 marked, 1 hidden');
    expect(markSummary(loaded())).toBeUndefined();
  });
});

describe('TUI reducer, d dry run', () => {
  it('d runs the selected zone with write off when no zone is marked', () => {
    const s = select(loaded(), 'b.example.net');
    const { state, effects } = press(s, 'd');
    expect(effects).toEqual([applyEffect(s, 'b.example.net', false)]);
    expect(state.mode).toEqual({ kind: 'running' });
  });

  it('d shows the planLines text and the outcome text, then goes back to NORMAL', () => {
    const s = press(select(loaded(), 'b.example.net'), 'd').state;
    const done = run(s, [
      { type: 'plan-ready', zone: 'b.example.net', plan: PLAN_B },
      { type: 'zone-done', zone: 'b.example.net', outcome: 'dry run' },
    ]);
    expect(paneText(done.state)).toEqual([...planLines(PLAN_B), `b.example.net: ${applyOutcomeText('dry run')}`]);
    expect(done.state.mode).toEqual({ kind: 'normal' });
    expect(done.effects).toEqual([]);
  });

  it('d runs the visible marked zones in list order and skips not managed and error zones', () => {
    const s = marked(['e.example.com', 'b.example.net', 'd.example.net']);
    const first = press(s, 'd');
    expect(first.effects).toEqual([applyEffect(s, 'b.example.net', false)]);
    const done = run(first.state, [{ type: 'zone-done', zone: 'b.example.net', outcome: 'no change' }]);
    expect(done.effects).toEqual([]);
    expect(done.state.mode).toEqual({ kind: 'normal' });
    expect(paneText(select(done.state, 'd.example.net'))).toEqual(['d.example.net: skipped: getPhase failed: 403']);
    expect(paneText(select(done.state, 'e.example.com'))).toEqual(['e.example.com: skipped, not managed; run flarewall add e.example.com']);
  });

  it('d in the diff pane runs the selected zone only, even with marks', () => {
    const s = { ...select(loaded(), 'c.example.com'), marks: ['b.example.net'] };
    expect(press(s, 'l', 'd').effects).toEqual([applyEffect(s, 'c.example.com', false)]);
  });

  it('d skips the marked zones that a filter hides', () => {
    const s = run(marked(['a.example.com', 'b.example.net']), [...[...'/net'].map(key), key('enter')]).state;
    expect(press(s, 'd').effects).toEqual([applyEffect(s, 'b.example.net', false)]);
  });
});

describe('TUI reducer, a write and CONFIRM', () => {
  /** a on b.example.net, its plan on screen, and the prompt open. */
  const confirming = () =>
    run(press(select(loaded(), 'b.example.net'), 'a').state, [
      { type: 'plan-ready', zone: 'b.example.net', plan: PLAN_B },
      { type: 'confirm-asked', zone: 'b.example.net' },
    ]).state;

  it('a runs the selected zone with write on', () => {
    const s = select(loaded(), 'b.example.net');
    const { state, effects } = press(s, 'a');
    expect(effects).toEqual([applyEffect(s, 'b.example.net', true)]);
    expect(state.mode).toEqual({ kind: 'running' });
  });

  it('the confirm callback opens CONFIRM with the plan and the prompt on screen', () => {
    const s = confirming();
    expect(s.mode).toEqual({ kind: 'confirm', zone: 'b.example.net' });
    expect(paneText(s)).toEqual([...planLines(PLAN_B), 'Apply the baseline to b.example.net? [y/N]']);
    expect(diffPaneTitle(s)).toBe('b.example.net plan (1 of 1)');
  });

  it('y in CONFIRM answers yes and goes to RUNNING', () => {
    const { state, effects } = press(confirming(), 'y');
    expect(effects).toEqual([{ kind: 'confirm-answer', yes: true }]);
    expect(state.mode).toEqual({ kind: 'running' });
  });

  it.each(['n', 'enter'])('%s in CONFIRM answers no', (k) => {
    const { state, effects } = press(confirming(), k);
    expect(effects).toEqual([{ kind: 'confirm-answer', yes: false }]);
    expect(state.mode).toEqual({ kind: 'running' });
  });

  it('other keys in CONFIRM do nothing', () => {
    const s = confirming();
    const { state, effects } = press(s, 'd', 'a', 'j', 'q');
    expect(effects).toEqual([]);
    expect(state.mode).toEqual(s.mode);
    expect(state.selected).toBe('b.example.net');
  });

  it('esc in CONFIRM answers no and skips the remaining zones', () => {
    const s = marked(['b.example.net', 'c.example.com']);
    let r = run(press(s, 'a').state, [
      { type: 'plan-ready', zone: 'b.example.net', plan: PLAN_B },
      { type: 'confirm-asked', zone: 'b.example.net' },
    ]);
    expect(diffPaneTitle(r.state)).toBe('b.example.net plan (1 of 2)');
    r = run(r.state, [key('y'), { type: 'zone-done', zone: 'b.example.net', outcome: 'applied' }]);
    expect(r.effects).toEqual([
      { kind: 'confirm-answer', yes: true },
      { kind: 'refresh-zone', gen: s.gen, zone: 'b.example.net', data: s.data },
      applyEffect(s, 'c.example.com', true),
    ]);
    expect(r.state.selected).toBe('c.example.com');
    r = run(r.state, [{ type: 'plan-ready', zone: 'c.example.com', plan: PLAN_C }, { type: 'confirm-asked', zone: 'c.example.com' }]);
    expect(diffPaneTitle(r.state)).toBe('c.example.com plan (2 of 2)');
    const stop = press(r.state, 'esc');
    expect(stop.effects).toEqual([{ kind: 'confirm-answer', yes: false }]);
    const end = run(stop.state, [{ type: 'zone-done', zone: 'c.example.com', outcome: 'declined' }]);
    expect(end.effects).toEqual([]);
    expect(end.state.mode).toEqual({ kind: 'normal' });
  });

  it('esc in CONFIRM on the first of two zones never starts the second', () => {
    const s = marked(['b.example.net', 'c.example.com']);
    const r = run(s, [key('a'), { type: 'confirm-asked', zone: 'b.example.net' }, key('esc'), { type: 'zone-done', zone: 'b.example.net', outcome: 'declined' }]);
    expect(r.effects).toEqual([applyEffect(s, 'b.example.net', true), { kind: 'confirm-answer', yes: false }]);
    expect(r.state.mode).toEqual({ kind: 'normal' });
  });

  it('after a write, the row refreshes and the pane keeps the backup path and the outcome text', () => {
    const s = confirming();
    const r = run(s, [
      key('y'),
      { type: 'backup-written', zone: 'b.example.net', path: '/data/backups/b.example.net/20261021T081500Z' },
      { type: 'zone-done', zone: 'b.example.net', outcome: 'applied' },
    ]);
    expect(r.state.zones.find((z) => z.zone === 'b.example.net')?.report).toBeUndefined();
    expect(paneText(r.state)).toEqual([
      ...planLines(PLAN_B),
      'b.example.net: backup written to /data/backups/b.example.net/20261021T081500Z',
      `b.example.net: ${applyOutcomeText('applied')}`,
    ]);
    expect(r.state.writeFailed).toBe(false);
  });

  it('a failed write shows the error and the backup path, marks the row error, and records the failure', () => {
    const r = run(confirming(), [
      key('y'),
      { type: 'backup-written', zone: 'b.example.net', path: '/data/backups/b.example.net/20261021T081500Z' },
      { type: 'zone-failed', zone: 'b.example.net', error: 'updatePhase failed: 403' },
    ]);
    expect(paneText(r.state)).toEqual([
      ...planLines(PLAN_B),
      'b.example.net: backup written to /data/backups/b.example.net/20261021T081500Z',
      'b.example.net: error: updatePhase failed: 403',
    ]);
    expect(r.state.zones.find((z) => z.zone === 'b.example.net')?.report?.state).toBe('error');
    expect(r.state.writeFailed).toBe(true);
    expect(r.state.mode).toEqual({ kind: 'normal' });
    expect(r.effects.filter((e) => e.kind === 'refresh-zone')).toEqual([]);
    // r refreshes the row and drops the run text, so the diff shows again.
    const refreshed = press(r.state, 'r').state;
    expect(refreshed.runLines['b.example.net']).toBeUndefined();
  });

  it('a failed dry run does not count as a failed write', () => {
    const s = press(select(loaded(), 'b.example.net'), 'd').state;
    const r = run(s, [{ type: 'zone-failed', zone: 'b.example.net', error: 'skipped, over the Free plan limit' }]);
    expect(r.state.writeFailed).toBe(false);
    expect(r.state.zones.find((z) => z.zone === 'b.example.net')?.report?.state).toBe('error');
  });
});

describe('TUI reducer, RUNNING', () => {
  const running = () => press(select(loaded(), 'b.example.net'), 'd').state;

  it('d, a, r, and R are ignored until the run ends', () => {
    const s = running();
    const r = press(s, 'd', 'a', 'r', 'R');
    expect(r.effects).toEqual([]);
    expect(r.state.gen).toBe(s.gen);
    expect(r.state.mode).toEqual({ kind: 'running' });
  });

  it('j and k still move the selection, and ? opens help', () => {
    const s = running();
    expect(press(s, 'j').state.selected).toBe('c.example.com');
    expect(press(s, 'k').state.selected).toBe('a.example.com');
    expect(press(s, '?').state.help).toBe(true);
  });

  it('ctrl-c lets the current zone finish, then quits', () => {
    const s = marked(['b.example.net', 'c.example.com']);
    const r = run(s, [key('a'), { type: 'confirm-asked', zone: 'b.example.net' }, key('y'), key('ctrl-c')]);
    expect(r.effects).toEqual([applyEffect(s, 'b.example.net', true), { kind: 'confirm-answer', yes: true }]);
    const end = run(r.state, [{ type: 'zone-done', zone: 'b.example.net', outcome: 'applied' }]);
    expect(end.effects).toEqual([{ kind: 'refresh-zone', gen: s.gen, zone: 'b.example.net', data: s.data }, { kind: 'quit' }]);
  });

  it('ctrl-c in CONFIRM acts as esc, then quits', () => {
    const s = marked(['b.example.net', 'c.example.com']);
    const r = run(s, [key('a'), { type: 'confirm-asked', zone: 'b.example.net' }, key('ctrl-c')]);
    expect(r.effects).toEqual([applyEffect(s, 'b.example.net', true), { kind: 'confirm-answer', yes: false }]);
    const end = run(r.state, [{ type: 'zone-done', zone: 'b.example.net', outcome: 'declined' }]);
    expect(end.effects).toEqual([{ kind: 'quit' }]);
  });

  it('esc in RUNNING skips the remaining zones without quitting', () => {
    const s = marked(['b.example.net', 'c.example.com']);
    const r = run(s, [key('d'), key('esc'), { type: 'zone-done', zone: 'b.example.net', outcome: 'dry run' }]);
    expect(r.effects).toEqual([applyEffect(s, 'b.example.net', false)]);
    expect(r.state.mode).toEqual({ kind: 'normal' });
  });
});

describe('TUI key map, Phase 3', () => {
  it('names every Phase 3 key in the help table', () => {
    const keys = new Set(KEYMAP.flatMap((b) => b.keys.map((k) => `${b.scope} ${k}`)));
    for (const k of ['zones space', 'zones ctrl-a', 'zones ctrl-x', 'zones d', 'zones a', 'diff d', 'diff a', 'confirm y', 'confirm n', 'confirm enter', 'confirm esc', 'running j', 'running k']) {
      expect(keys).toContain(k);
    }
  });
});
