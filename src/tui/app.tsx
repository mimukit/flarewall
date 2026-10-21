// The Ink screen, layout A: header, zone list, diff pane, and the mode chip with key hints.
// Components render the state and send key events. No Cloudflare call and no rule logic here.
import { Box, Text, useInput, useWindowSize, type Key } from 'ink';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { hints, KEYMAP, SCOPE_TITLES, type Scope } from './keymap.js';
import {
  bodyHeight,
  columnWidths,
  diffPaneLines,
  isNarrow,
  LIST_HEADERS,
  listHeight,
  listWidth,
  rowCells,
  hintScopes,
  selectedRow,
  stateWord,
  visibleRows,
  type TuiEvent,
  type TuiState,
} from './state.js';
import type { Store } from './store.js';

/** The fixed state colours. Every state also shows as a word, so colour is never the only signal. */
const STATE_COLOR: Readonly<Record<string, string>> = {
  'in sync': 'green',
  drift: 'yellow',
  legacy: 'magenta',
  error: 'red',
  'not managed': 'gray',
};

/** Turns an Ink key press into a key event with a key map name. */
export function keyEvent(input: string, key: Key): TuiEvent | undefined {
  const named = (name: string): TuiEvent => ({ type: 'key', key: name });
  if (key.ctrl && /^[a-z]$/i.test(input)) return named(`ctrl-${input.toLowerCase()}`);
  if (key.upArrow) return named('up');
  if (key.downArrow) return named('down');
  if (key.leftArrow) return named('left');
  if (key.rightArrow) return named('right');
  if (key.return) return named('enter');
  if (key.escape) return named('esc');
  if (key.tab) return named(key.shift ? 'shift-tab' : 'tab');
  if (key.backspace || key.delete) return named('backspace');
  if (input === '' || key.ctrl || key.meta) return undefined;
  return { type: 'key', key: input, text: input };
}

function oneLine(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

function StateText({ word, width }: { word: string; width?: number }) {
  const text = width === undefined ? word : word.padEnd(width);
  const color = STATE_COLOR[word];
  return color === undefined ? <Text dimColor>{text}</Text> : <Text color={color}>{text}</Text>;
}

/** A bordered pane with its title, and an optional state word, in the top border. */
function Pane({ title, word, width, height, focused, children }: { title: string; word?: string; width: number; height: number; focused: boolean; children: ReactNode }) {
  const color = focused ? 'cyan' : undefined;
  const label = word === undefined ? title : `${title} ${word}`;
  const dashes = Math.max(0, width - label.length - 4);
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end">
        <Text color={color}>┌ </Text>
        {title}
        {word === undefined ? null : (
          <>
            {' '}
            <StateText word={word} />
          </>
        )}
        <Text color={color}>{` ${'─'.repeat(dashes)}┐`}</Text>
      </Text>
      <Box borderStyle="single" borderTop={false} borderColor={color} width={width} height={height + 1} flexDirection="column" overflow="hidden">
        {/* Lines keep their height; the border box clips what does not fit. */}
        <Box flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

function Header({ state }: { state: TuiState }) {
  const count = (word: string) => state.zones.filter((r) => stateWord(r) === word).length;
  const loading = count('loading');
  const parts = [
    'flarewall',
    ...(isNarrow(state) ? [state.focus === 'zones' ? '1/2' : '2/2'] : []),
    `data ${state.dataDir}`,
    `${state.zones.length} zones`,
    `${count('drift')} drift`,
    `${count('legacy')} legacy`,
    `${count('error')} error`,
    ...(loading > 0 ? [`${loading} loading`] : []),
    `filter: ${state.stateFilter}${state.filterText === '' ? '' : ` /${state.filterText}`}`,
    `sort: ${state.sort}`,
  ];
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{parts.join('  ')}</Text>
      {state.error === undefined ? null : (
        <Text color="red" wrap="truncate-end">
          {oneLine(state.error)}
        </Text>
      )}
    </Box>
  );
}

function ZonesPane({ state, width }: { state: TuiState; width: number }) {
  const widths = columnWidths(state);
  const cells = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] ?? 0));
  const rows = visibleRows(state).slice(state.listTop, state.listTop + listHeight(state));
  return (
    <Pane title="Zones" width={width} height={bodyHeight(state)} focused={state.focus === 'zones'}>
      <Text bold wrap="truncate-end">
        {'  '}
        {cells([...LIST_HEADERS]).join('  ').trimEnd()}
      </Text>
      {rows.map((row) => {
        const [zone, plan, word, ...rest] = cells(rowCells(row));
        const selected = row.zone === state.selected;
        return (
          <Text key={row.zone} wrap="truncate-end" bold={selected}>
            {selected ? '> ' : '  '}
            {zone}
            {'  '}
            {plan}
            {'  '}
            <StateText word={stateWord(row)} width={(word ?? '').length} />
            {'  '}
            {rest.join('  ').trimEnd()}
          </Text>
        );
      })}
    </Pane>
  );
}

function DiffPane({ state, width }: { state: TuiState; width: number }) {
  const row = selectedRow(state);
  const lines = diffPaneLines(state).slice(state.diffScroll, state.diffScroll + bodyHeight(state));
  return (
    <Pane title={row?.zone ?? 'No zone'} {...(row === undefined ? {} : { word: stateWord(row) })} width={width} height={bodyHeight(state)} focused={state.focus === 'diff'}>
      {lines.map((line, i) => (
        <Text key={`${state.diffScroll + i}`} wrap="wrap">
          {line.text}
        </Text>
      ))}
    </Pane>
  );
}

function HelpPane({ state }: { state: TuiState }) {
  const groups: Scope[] = ['any', 'zones', 'diff', 'filter'];
  const keys = (list: readonly string[]) => (list.length === 0 ? 'text' : list.join('/'));
  const width = Math.max(...KEYMAP.map((b) => keys(b.keys).length));
  return (
    <Pane title="Help" width={state.columns} height={bodyHeight(state)} focused>
      {groups.flatMap((scope) => [
        <Text key={scope} bold wrap="truncate-end">
          {SCOPE_TITLES[scope]}
        </Text>,
        ...KEYMAP.filter((b) => b.scope === scope).map((b) => (
          <Text key={`${scope} ${b.action}`} wrap="truncate-end">
            {'  '}
            {keys(b.keys).padEnd(width)}
            {'  '}
            {b.help}
          </Text>
        )),
      ])}
    </Pane>
  );
}

function HintLine({ state }: { state: TuiState }) {
  const mode = state.help ? 'HELP' : state.mode.kind === 'filter' ? 'FILTER' : 'NORMAL';
  const filter = state.mode.kind === 'filter' && !state.help ? `/${state.filterText}_  ` : '';
  return (
    <Text wrap="truncate-end">
      <Text inverse bold>
        {` ${mode} `}
      </Text>
      {`  ${filter}${hints(hintScopes(state)).join('  ')}`}
    </Text>
  );
}

function Body({ state }: { state: TuiState }) {
  if (state.help) return <HelpPane state={state} />;
  if (isNarrow(state)) {
    return state.focus === 'zones' ? <ZonesPane state={state} width={state.columns} /> : <DiffPane state={state} width={state.columns} />;
  }
  const left = listWidth(state);
  return (
    <Box>
      <ZonesPane state={state} width={left} />
      <DiffPane state={state} width={state.columns - left} />
    </Box>
  );
}

export interface AppProps {
  store: Store;
  /** A fixed terminal height; tests set it, since a fake stdout has no rows. */
  rows?: number;
}

export function App({ store, rows }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const size = useWindowSize();
  const height = rows ?? size.rows;

  useEffect(() => {
    store.dispatch({ type: 'resize', columns: size.columns, rows: height });
  }, [store, size.columns, height]);
  useEffect(() => {
    store.dispatch({ type: 'start' });
  }, [store]);
  useInput((input, key) => {
    const event = keyEvent(input, key);
    if (event !== undefined) store.dispatch(event);
  });

  return (
    <Box flexDirection="column" width={state.columns}>
      <Header state={state} />
      <Body state={state} />
      <HintLine state={state} />
    </Box>
  );
}
