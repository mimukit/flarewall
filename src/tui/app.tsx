// The Ink screen, layout A: header, zone list, diff pane, and the mode chip with key hints.
// Components render the state and send key events. No Cloudflare call and no rule logic here.
import { Box, Text, useInput, useWindowSize, type Key } from 'ink';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { hintBindings, KEYMAP, SCOPE_TITLES, type Scope } from './keymap.js';
import {
  bodyHeight,
  CARD_LABEL_WIDTH,
  canRun,
  columnWidths,
  confirmPrompt,
  diffPaneLines,
  diffPaneTitle,
  headerCounts,
  isNarrow,
  listHeaders,
  listHeight,
  listWidth,
  markSummary,
  NUMBER_COLUMNS,
  rowCells,
  hintScopes,
  selectedRow,
  stateLabel,
  stateWord,
  visibleRows,
  zonesPaneWidth,
  type TuiEvent,
  type TuiState,
} from './state.js';
import type { Store } from './store.js';
import { lineColor, STATE_COLOR, THEME } from './theme.js';

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
  if (input === ' ') return { type: 'key', key: 'space', text: ' ' };
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

/** A state word with its mark, in the state colour. */
function StateText({ word, width }: { word: string; width?: number }) {
  const label = stateLabel(word);
  const text = width === undefined ? label : label.padEnd(width);
  return <Text color={STATE_COLOR[word] ?? THEME.muted}>{text}</Text>;
}

/**
 * A pane with rounded borders. The title, and an optional state word, sit in the top border;
 * an optional footer, such as the position in the list, sits at the right of the bottom border.
 * The focused pane has an accent border and a bold title; the other pane has a grey border.
 */
function Pane({ title, word, footer, width, height, focused, children }: { title: string; word?: string; footer?: string; width: number; height: number; focused: boolean; children: ReactNode }) {
  const color = focused ? THEME.activeBorder : THEME.inactiveBorder;
  const label = word === undefined ? title : `${title} ${stateLabel(word)}`;
  const dashes = Math.max(0, width - label.length - 4);
  const tail = footer === undefined ? '' : ` ${footer} ─`;
  return (
    <Box flexDirection="column" width={width}>
      {title === '' ? (
        <Text wrap="truncate-end" color={color}>{`╭${'─'.repeat(Math.max(0, width - 2))}╮`}</Text>
      ) : (
        <Text wrap="truncate-end">
          <Text color={color}>╭ </Text>
          <Text bold={focused} color={focused ? THEME.activeBorder : THEME.inactiveTitle}>
            {title}
          </Text>
          {word === undefined ? null : (
            <>
              {' '}
              <StateText word={word} />
            </>
          )}
          <Text color={color}>{` ${'─'.repeat(dashes)}╮`}</Text>
        </Text>
      )}
      <Box borderStyle="round" borderTop={false} borderBottom={false} borderColor={color} width={width} height={height} paddingX={1} flexDirection="column" overflow="hidden">
        {/* Lines keep their height; the border box clips what does not fit. */}
        <Box flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      <Text wrap="truncate-end" color={color}>
        {`╰${'─'.repeat(Math.max(0, width - 2 - tail.length))}${tail}╯`}
      </Text>
    </Box>
  );
}

/** The reload error, in red on the top line, as the plan's reload rule asks. Absent with no error. */
function ErrorLine({ state }: { state: TuiState }) {
  if (state.error === undefined) return null;
  return (
    <Text color={THEME.danger} wrap="truncate-end">
      {oneLine(state.error)}
    </Text>
  );
}

/** The widths of the search bar and the Filters bar. In two panes they line up with the list and the details pane. */
function barWidths(state: TuiState, filters: string): [number, number] {
  if (!isNarrow(state)) {
    const left = zonesPaneWidth(state);
    return [left, state.columns - left];
  }
  const right = Math.min(Math.max(filters.length + 4, 24), Math.floor(state.columns / 2));
  return [state.columns - right, right];
}

/** The top bars: the zone name search on the left, and the state filter, the sort, and the marks on the right. */
function TopBars({ state }: { state: TuiState }) {
  const typing = state.mode.kind === 'filter' && !state.help;
  const marks = markSummary(state);
  const filters = `state: ${state.stateFilter}  sort: ${state.sort} ↓${marks === undefined ? '' : `  ${marks}`}`;
  const [left, right] = barWidths(state, filters);
  return (
    <Box>
      <Pane title="Search" width={left} height={1} focused={typing}>
        <Text wrap="truncate-end" color={THEME.text}>
          {typing ? (
            `/ ${state.filterText}_`
          ) : state.filterText === '' ? (
            <Text color={THEME.muted}>/ filter zones by name</Text>
          ) : (
            `/ ${state.filterText}`
          )}
        </Text>
      </Pane>
      <Pane title="Filters" width={right} height={1} focused={false}>
        <Text wrap="truncate-end" color={THEME.text}>
          {filters}
        </Text>
      </Pane>
    </Box>
  );
}

/** The summary under the panes: the pane in view on a narrow terminal, the zone counts, and the data repo. */
function Summary({ state }: { state: TuiState }) {
  const bar = <Text color={THEME.separator}>{' | '}</Text>;
  return (
    <Text wrap="truncate-end" color={THEME.hint}>
      {isNarrow(state) && !state.help ? (
        <>
          <Text color={THEME.activeBorder}>{state.focus === 'zones' ? '1/2' : '2/2'}</Text>
          {bar}
        </>
      ) : null}
      <Text bold color={THEME.text}>
        {state.zones.length}
      </Text>
      {' zones'}
      {headerCounts(state).map(({ word, count }) => (
        <Text key={word}>
          {bar}
          {/* A zero count stays muted, so only the states that need a look carry colour. */}
          {count === 0 ? <Text color={THEME.muted}>0</Text> : <Text color={STATE_COLOR[word]} bold>{String(count)}</Text>}
          {` ${word}`}
        </Text>
      ))}
      {bar}
      {`data ${state.dataDir}`}
    </Text>
  );
}

function ZonesPane({ state, width }: { state: TuiState; width: number }) {
  const widths = columnWidths(state);
  const cells = (row: string[]) => row.map((c, i) => (NUMBER_COLUMNS.includes(i) ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)));
  const visible = visibleRows(state);
  const rows = visible.slice(state.listTop, state.listTop + listHeight(state));
  const at = visible.findIndex((r) => r.zone === state.selected);
  return (
    <Pane title="Zones" footer={at === -1 ? `0 of ${visible.length}` : `${at + 1} of ${visible.length}`} width={width} height={bodyHeight(state)} focused={state.focus === 'zones'}>
      <Text bold color={THEME.heading} wrap="truncate-end">
        {'  '}
        {cells(listHeaders(state)).join('  ').trimEnd()}
      </Text>
      {rows.map((row) => {
        const [zone, plan, word, ...rest] = cells(rowCells(row));
        const selected = row.zone === state.selected;
        return (
          // The selection is a surface bar over the whole row, so the eye follows it across the columns.
          <Text key={row.zone} wrap="truncate-end" color={THEME.text} bold={selected} {...(selected ? { backgroundColor: THEME.selection } : {})}>
            <Text color={THEME.activeBorder}>{selected ? '>' : ' '}</Text>
            <Text color={THEME.mark}>{state.marks.includes(row.zone) ? '●' : ' '}</Text>
            {zone}
            {'  '}
            {plan}
            {'  '}
            <StateText word={stateWord(row)} width={(word ?? '').length} />
            {'  '}
            {/* The bar runs to the pane's inner edge, past the last column, when the pane is wider than the list. */}
            {selected ? `${rest.join('  ')}${' '.repeat(Math.max(0, width - listWidth(state)))}` : rest.join('  ').trimEnd()}
          </Text>
        );
      })}
    </Pane>
  );
}

function DiffPane({ state, width }: { state: TuiState; width: number }) {
  const row = selectedRow(state);
  const all = diffPaneLines(state);
  const height = bodyHeight(state);
  const lines = all.slice(state.diffScroll, state.diffScroll + height);
  // The footer shows the visible line range only when the text does not fit.
  const footer = all.length > height ? `${state.diffScroll + 1}-${Math.min(state.diffScroll + height, all.length)} of ${all.length}` : undefined;
  return (
    <Pane title={diffPaneTitle(state)} {...(row === undefined || state.runLines[row.zone] !== undefined ? {} : { word: stateWord(row) })} {...(footer === undefined ? {} : { footer })} width={width} height={height} focused={state.focus === 'diff'}>
      {lines.map((line, i) => (
        // Ink gives an empty Text no height, so a blank line renders as one space.
        <Text key={`${state.diffScroll + i}`} wrap="wrap">
          {line.label === undefined ? null : <Text color={THEME.muted}>{line.label.padEnd(CARD_LABEL_WIDTH)}</Text>}
          <Text color={line.label === undefined ? (lineColor(line.text) ?? THEME.text) : THEME.text}>{line.text === '' ? ' ' : line.text}</Text>
        </Text>
      ))}
    </Pane>
  );
}

function HelpPane({ state }: { state: TuiState }) {
  const groups: Scope[] = ['any', 'zones', 'diff', 'filter', 'confirm', 'running'];
  const keys = (list: readonly string[]) => (list.length === 0 ? 'text' : list.join('/'));
  const width = Math.max(...KEYMAP.map((b) => keys(b.keys).length));
  return (
    <Pane title="Help" width={state.columns} height={bodyHeight(state)} focused>
      {groups.flatMap((scope) => [
        <Text key={scope} bold color={THEME.heading} wrap="truncate-end">
          {SCOPE_TITLES[scope]}
        </Text>,
        ...KEYMAP.filter((b) => b.scope === scope).map((b) => (
          <Text key={`${scope} ${b.action}`} wrap="truncate-end" color={THEME.text}>
            {'  '}
            <Text color={THEME.key}>{keys(b.keys).padEnd(width)}</Text>
            {'  '}
            {b.help}
          </Text>
        )),
      ])}
    </Pane>
  );
}

/** The key hints of the current mode. In CONFIRM, the y/N prompt leads the line in bold red. */
function HintLine({ state }: { state: TuiState }) {
  const ask = state.mode.kind === 'confirm' && !state.help ? confirmPrompt(state.mode.zone) : undefined;
  // `d` and `a` stay in the line, as the mode's keys, but dim when every target zone would be skipped.
  const idle = !canRun(state);
  return (
    <Text wrap="truncate-end">
      {ask === undefined ? null : (
        <Text color={THEME.danger} bold>
          {`${ask}  `}
        </Text>
      )}
      {hintBindings(hintScopes(state)).map((b, i) => {
        // The key in the accent colour, then its action in plain text. A typed-text hint has no key.
        const hint = b.hint as string;
        const space = hint.indexOf(' ');
        const keys = b.keys.length === 0 || space === -1 ? '' : hint.slice(0, space);
        const dim = idle && (b.action === 'dry-run' || b.action === 'apply');
        return (
          <Text key={`${b.scope} ${b.action}`} color={dim ? THEME.idle : THEME.hint}>
            {i === 0 ? '' : '  '}
            {keys === '' ? null : <Text color={dim ? THEME.idle : THEME.key}>{keys}</Text>}
            {keys === '' ? hint : hint.slice(space)}
          </Text>
        );
      })}
    </Text>
  );
}

/** The footer box under the panes: the summary line, then the key hints. */
function Footer({ state }: { state: TuiState }) {
  return (
    <Pane title="" width={state.columns} height={2} focused={false}>
      <Summary state={state} />
      <HintLine state={state} />
    </Pane>
  );
}

function Body({ state }: { state: TuiState }) {
  if (state.help) return <HelpPane state={state} />;
  if (isNarrow(state)) {
    return state.focus === 'zones' ? <ZonesPane state={state} width={state.columns} /> : <DiffPane state={state} width={state.columns} />;
  }
  const left = zonesPaneWidth(state);
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
    // No background colour: the terminal's own background shows through, so the TUI sits in the terminal theme.
    <Box flexDirection="column" width={state.columns}>
      <ErrorLine state={state} />
      <TopBars state={state} />
      <Body state={state} />
      <Footer state={state} />
    </Box>
  );
}
