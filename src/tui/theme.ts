// The TUI colours: the Catppuccin Mocha palette, and the role each colour plays on the screen.
// Components take colours from here only, so one file sets the look.
// Palette: https://catppuccin.com/palette (Mocha). Roles follow the Catppuccin lazygit theme.

/** The Catppuccin Mocha palette. */
export const MOCHA = {
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',
  surface2: '#585b70',
  surface1: '#45475a',
  surface0: '#313244',
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
} as const;

/** The screen roles. */
export const THEME = {
  /** Plain text. */
  text: MOCHA.text,
  /** The primary colour: the border and the title of the focused pane, the pane counter, the row cursor, and the Search bar in FILTER mode. */
  primary: MOCHA.green,
  /** The border of every other pane. */
  inactiveBorder: MOCHA.overlay0,
  /** The title of a pane without focus. */
  inactiveTitle: MOCHA.subtext0,
  /** The list column headers and the help overlay group titles. */
  heading: MOCHA.lavender,
  /** The selection bar behind the selected row. */
  selection: MOCHA.surface1,
  /** The mark `●` before a marked row. */
  mark: MOCHA.peach,
  /** A key in the hint line and in the help overlay. */
  key: MOCHA.mauve,
  /** The action text after a key in the hint line. */
  hint: MOCHA.subtext1,
  /** A key that would do nothing now, such as `d` on a not managed zone. */
  idle: MOCHA.surface2,
  /** A zone card label, the placeholder text, and a zero count. */
  muted: MOCHA.overlay1,
  /** The `|` between the summary fields. */
  separator: MOCHA.surface2,
  /** The reload error line and the CONFIRM prompt. */
  danger: MOCHA.red,
} as const;

/**
 * The state colours: the Catppuccin terminal colours for the plan's fixed state colours
 * (green, yellow, magenta, red, and grey). Every state also shows as a word and a mark.
 */
export const STATE_COLOR: Readonly<Record<string, string>> = {
  'in sync': MOCHA.green,
  drift: MOCHA.yellow,
  legacy: MOCHA.pink,
  error: MOCHA.red,
  'not managed': MOCHA.subtext0,
  loading: MOCHA.overlay1,
};

/** Diff pane line colours, by the words the shared CLI text puts in each line. First match wins. */
const LINE_TONES: readonly (readonly [RegExp, string])[] = [
  [/: error\b|^error\b|\? \[y\/N\]$/, MOCHA.red],
  [/: missing |^create /, MOCHA.green],
  [/: changed |: order is |^setting |^bot management|^update /, MOCHA.yellow],
  [/: legacy |^replace legacy /, MOCHA.pink],
  [/: extra |^remove /, MOCHA.red],
  [/: unowned |^keep unowned |: no change$/, MOCHA.overlay1],
  [/: applied, |: restored, |in sync, nothing to send/, MOCHA.green],
  [/: declined, |: skipped|dry run, nothing sent/, MOCHA.subtext0],
  [/backup written to /, MOCHA.sapphire],
];

/** The colour of one diff pane line, or undefined for plain text. */
export function lineColor(text: string): string | undefined {
  const line = text.trim();
  return LINE_TONES.find(([pattern]) => pattern.test(line))?.[1];
}
