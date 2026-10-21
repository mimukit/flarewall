// The TUI reducer: one test per key map row in Phase 2 scope, plus the data events.
import { describe, expect, it } from 'vitest';
import type { Change } from '../src/core/diff.js';
import type { Phase } from '../src/core/render.js';
import { parseInventory, type Inventory } from '../src/core/schema.js';
import type { ZoneReport } from '../src/core/status.js';
import { KEYMAP } from '../src/tui/keymap.js';
import { diffPaneLines, initialState, update, visibleRows, type Effect, type TuiEvent, type TuiState } from '../src/tui/state.js';
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
