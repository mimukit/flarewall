# Plan: flarewall TUI

Grilled: 2026-10-21

## Context

Issue #3 is Phase 6 of `docs/plans/0001-plan-flarewall-2026-10-21.md`. The owner runs 10 to 50 zones. Today the owner reads `flarewall status`, then runs `flarewall diff <zone>` for each drifted zone, then `flarewall apply <zone> --write`. Each step is a new command and a new full read of the zones.

The TUI puts the three steps on one screen. It lists every zone with its state, shows the diff of the selected zone beside the list, and starts a dry run or a write from a key. The TUI is a front end. It calls the same core as the CLI and holds no rule logic.

Success: the owner opens `flarewall tui`, sees every inventory zone with the state that `flarewall status` prints, moves to a drifted zone, reads its diff, and applies it with the same backup, per-zone prompt, and read-back as `flarewall apply --write`.

## Design decisions (settled)

| Decision | Resolution |
|----------|-----------|
| Scope | Read and apply. The TUI shows status and diff for every zone, refreshes, dry-runs, and applies. `restore`, `add`, and `init` stay in the CLI. |
| Screen sketch | Layout A, two panes: the zone list on the left, the diff or plan of the selected zone on the right, a header with counts per state, and a mode chip with key hints at the bottom. The owner approved it on 2026-10-21. [Screen sketch](#screen-sketch) holds the text form. |
| Key map | Vim keys with the arrow keys as aliases, in the style of lazygit and zellij. Five modes: NORMAL, FILTER, CONFIRM, RUNNING, and the help overlay. The full map is in [Key map](#key-map). The owner approved every row on 2026-10-21, including marks, sort, and value detail. |
| Write gate | No start flag. `a` starts a write on the marked zones, or on the selected zone when none is marked. Every write zone stops in CONFIRM mode for its own y/N prompt, and the default is no. There is no "yes to all" key. This keeps the CLI's per-zone confirmation. |
| Safety steps | The TUI calls `applyZone` with `write: true`, the same `createBackupWriter`, and a `confirm` callback that opens CONFIRM mode. `applyZone` calls `onPlan` before `confirm`, so the plan is on screen when the prompt shows. Backup, read-back, and the Free-plan limit check stay in the core. |
| Interrupt | `ctrl-c` during a write lets the current zone finish its write and read-back, then quits. It never stops a zone between its backup and its read-back. |
| Shared text | The line formatters in `src/cli/run.ts` (`statusLines`, `diffLines`, `planLines`, `stepLine`, `restoreLines`, `changeLine`, `foreignLine`) move to `src/cli/format.ts`. The CLI and the TUI both print them, so the two show the same words for one state. |
| Shared apply step | The per-zone body of the `apply` loop in `run.ts` (render against live DNS, then `applyZone`) moves to `applyInventoryZone` in `src/core/apply.ts`. It uses no Node API. The outcome text moves to `src/cli/format.ts`. The CLI and the TUI both call them. |
| Progressive load | `statusAll` takes an optional fifth argument `{ onReport }` and calls it once for each report, as each report is ready. The CLI does not pass it. The TUI draws the list at once from the inventory and one `listZones` call. Each row shows `loading` in its report columns until its report arrives. Zones are still read one after another, so the drift run's 429 back-off assumption holds. While the list is empty, it shows a spinner and the load step: reading the data repo, then listing the zones. After the load, an empty list says why: no zone matches the filter, the load failed, or the token sees no zone. |
| List columns | All columns, in this order: ZONE, PLAN, STATE, CHANGES, UNOWNED, HOSTS, GEO, REDIRECT. ZONE and PLAN come from `listZones`. HOSTS (the number of host roles), GEO (the country or `off`), and REDIRECT come from the inventory file, and they draw at once. STATE, CHANGES, and UNOWNED come from the report. A `not managed` zone shows `-` in the inventory columns. `s` cycles the sort through ZONE, STATE, PLAN, and CHANGES. |
| Narrow terminal | The TUI shows both panes when the terminal fits the list and a diff pane of at least 50 columns, about 130 columns with all columns. Below that, it shows one pane at a time, `tab` switches between them, and the header shows `1/2` or `2/2`. The key map stays the same. |
| Reload | `R` reloads `baseline.yaml`, the inventory files, and the live state of every zone. A parse error shows in red in the header as `<file>: <error>`, and the TUI keeps the last good data. `r` reloads the live state of the selected zone only. |
| Token scope | The TUI uses `CLOUDFLARE_API_TOKEN` for its whole run, as the CLI does. With a read-only token, a write fails at the first `updatePhase` after the backup is written. The zone is unchanged, the error shows, and the extra backup file stays. The TUI does not check the token scope. |
| Marks and filters | Marks stay when a filter hides a zone. `d` and `a` act only on visible marked zones. The header shows `<n> marked, <m> hidden` when a mark is hidden. |
| `ctrl-c` | Ink starts with `exitOnCtrlC: false`, and the reducer handles `ctrl-c`. During a write, the current zone finishes its write and read-back, then the TUI quits. With the CONFIRM prompt open, `ctrl-c` acts as `esc`, then quits. |
| Terminal | The TUI uses the alternate screen and restores the terminal on quit. With no TTY on stdin, `flarewall tui` prints an error and exits 2. It exits 0 on quit, or 2 when a write in the session failed. |
| Skipped zones | `d` and `a` skip a `not managed` zone with the line `press + to add it`, and skip an `error` zone with its error text. |
| Add | `+` writes the inventory entry of each marked `not managed` zone, or of the selected one, with the same `addZone` step as `flarewall add`. It writes a local file only and sends no Cloudflare write, so it opens no CONFIRM prompt. The TUI then reloads, and the diff pane shows the path of each new file until the next `r` or `R`. The owner asked for this key on 2026-10-21. |
| Write errors | When `applyInventoryZone` throws, the diff pane shows the error and the backup path when one exists. The row shows `error` until the next `r` or `R`. |
| Help overlay | The overlay comes from the same key table that the reducer reads, so the help and the keys stay the same. |
| TUI state | A pure reducer in `src/tui/state.ts` takes the state and a key and returns the new state. Ink components in `src/tui/` render the state and send keys to the reducer. No Cloudflare call and no rule logic sits in a component. |
| Loading | `flarewall tui` is a new case in `run.ts`. It loads Ink and React with a dynamic `import()`, so the other commands never load them. |
| Dependencies | `ink@8.0.0` and `react` 19.3 or later, pinned exactly. `ink-testing-library@4.0.0` and `@types/react` as dev dependencies. `tsconfig.json` gets `"jsx": "react-jsx"`, and `vitest.config.ts` includes `test/**/*.test.tsx`. |
| Tests | Vitest. The reducer gets plain unit tests, one per key map row. The screens get frame tests with `ink-testing-library`: send key presses, check the last frame. Both use `test/fake-api.ts` and `example.com` fixtures. Tests sit in `test/` beside the CLI tests. |
| UI house rules | The repo has no `DESIGN.md`. The rules for this plan, all new: the state words and colours are fixed (`in sync` green, `drift` yellow, `legacy` pink, `error` red, `not managed` subtext0 grey, all from the Catppuccin Mocha palette in `src/tui/theme.ts`, which holds every TUI colour); every state also shows as a word, so colour is never the only signal; the key hint line always names the keys of the current mode. |

## Approach

Build the shared text and the shared apply step first, behind the CLI tests that already pass. Then build the read-only TUI on the reducer. Add the write path last, so every read key works before any key can write.

Rejected alternatives:

- Layout B, a full-width list with a detail screen. It fits a narrow terminal but loses the side-by-side view, and the main task is to read a zone's diff while the list stays in view.
- A `--write` start flag. The owner rejected it. The per-zone CONFIRM prompt is the guard, as it is in the CLI.
- A TUI that shells out to the CLI and parses its output. It needs no refactor, but it couples the screen to the CLI's text and loses the typed `ZoneReport` and `ZonePlan`.

### Screen sketch

NORMAL mode, with one zone selected and one zone marked (`●`). The last row is still loading:

```
flarewall  data ~/flarewall-data   12 zones  3 drift  1 legacy  1 error  filter: all  1 marked
┌ Zones ─────────────────────────────────────────────────────────────────────┐┌ example.com drift ─────────────────────┐
│   ZONE          PLAN  STATE        CHANGES  UNOWNED  HOSTS  GEO  REDIRECT  ││ http_request_firewall_custom           │
│ > example.com   free  drift        2        1        3      off  root      ││   changed flarewall_probe_block        │
│ ● example.net   free  drift        1        0        2      off  www       ││     "Block probes" (expression)        │
│   example.org   free  legacy       0        0        1      off  root      ││ http_ratelimit                         │
│   shop.example  pro   in sync      0        0        4      off  https     ││   no change                            │
│   bad.example   free  error        -        -        2      off  root      ││ settings                               │
│   new.example   free  not managed  -        -        -      -    -         ││   always_use_https: live "off";        │
│   api.example   free  loading      -        -        1      off  skip      ││     want "on"                          │
└────────────────────────────────────────────────────────────────────────────┘└────────────────────────────────────────┘
 NORMAL  j/k move  ]/[ next problem  space mark  d dry run  a apply  / filter  r refresh  ? help
```

CONFIRM mode, after `a` on two marked zones:

```
┌ Zones ──────────────────────────────┐┌ example.com plan (1 of 2) ──────────────┐
│ > example.com    free   drift       ││ http_request_firewall_custom: send 5    │
│ ● example.net    free   drift       ││   rules (5 owned, 0 unowned)            │
│                                     ││   update flarewall_probe_block (id ...) │
│                                     ││ setting always_use_https: "off" -> "on" │
│                                     ││ Apply the baseline to example.com? [y/N]│
└─────────────────────────────────────┘└─────────────────────────────────────────┘
 CONFIRM  y apply this zone  n skip this zone  esc stop, skip the rest
```

### Key map

Any mode:

| Key | Action |
|-----|--------|
| `?` | Open or close the help overlay with this table |
| `ctrl-c` | Quit. During a write, the current zone finishes first |
| `esc` | Cancel the current mode and go back to NORMAL |

NORMAL, zones pane:

| Key | Action |
|-----|--------|
| `j` / `↓`, `k` / `↑` | Select the next or previous zone |
| `gg`, `G` | Select the first or last zone |
| `ctrl-d`, `ctrl-u` | Move half a page down or up |
| `]`, `[` | Select the next or previous zone in drift, legacy, or error |
| `l` / `tab` / `enter` | Focus the diff pane |
| `/` | Enter FILTER mode to filter zones by name |
| `n`, `N` | Select the next or previous filter match |
| `f` | Cycle the state filter: all, problems, drift, legacy, error, not managed |
| `s` | Cycle the sort: zone, state, plan, changes |
| `space` | Mark or unmark the selected zone |
| `ctrl-a`, `ctrl-x` | Mark all visible zones, or clear every mark |
| `r`, `R` | Refresh the selected zone, or refresh all zones |
| `+` | Write the inventory entry of each marked `not managed` zone, or of the selected one, then reload |
| `d` | Dry run on the marked zones, or the selected zone. The plan shows in the diff pane |
| `a` | Write on the marked zones, or the selected zone. Opens CONFIRM once per zone |
| `q` | Quit |

NORMAL, diff pane:

| Key | Action |
|-----|--------|
| `j`, `k` | Scroll one line |
| `ctrl-d`, `ctrl-u` | Scroll half a page |
| `gg`, `G` | Go to the top or bottom |
| `}`, `{` | Go to the next or previous section: one phase, settings, bot management |
| `z` | Show or hide the unowned and legacy rules |
| `e` | Show or hide the live and wanted values of each changed field |
| `h` / `shift-tab` / `esc` | Focus the zones pane |
| `+`, `d`, `a`, `r` | As in the zones pane, for the selected zone |

FILTER:

| Key | Action |
|-----|--------|
| text | Narrow the list on each key press |
| `enter` | Keep the filter and go back to NORMAL |
| `esc` | Clear the filter and go back to NORMAL |
| `ctrl-w`, `ctrl-u` | Delete a word, or delete the whole filter |

CONFIRM, one prompt per zone:

| Key | Action |
|-----|--------|
| `y` | Back up, write, and read back this zone, then go to the next marked zone |
| `n` / `enter` | Skip this zone. The default is no |
| `esc` | Stop the run and skip the remaining zones |

RUNNING, while API calls run:

| Key | Action |
|-----|--------|
| `j`, `k`, `?` | Still move the selection and open help |
| `+`, `d`, `a`, `r`, `R` | Ignored until the run or the add ends |

### Phase 1: share the CLI text and the apply step (built 2026-10-21)

Move the line formatters and the apply outcome text from `src/cli/run.ts` to `src/cli/format.ts`. Move the per-zone apply body to `applyInventoryZone` in `src/core/apply.ts`. Add the optional `{ onReport }` argument to `statusAll`. `run.ts` calls all three, and its output stays the same byte for byte.

Done when: `pnpm test` and `pnpm typecheck` pass with no change to any existing CLI test or snapshot, `run.ts` holds no formatter, and a new status test shows `onReport` called once for each report that `statusAll` returns, with the same reports.

### Phase 2: read-only TUI (built 2026-10-21)

Add the `tui` command with a lazy Ink import, the dependencies, and the JSX config. Build the reducer and layout A with all eight list columns, the progressive load, the narrow terminal mode, the NORMAL, FILTER, and help keys, the diff pane keys, and `r` and `R` with the reload rule. Add the alternate screen, the no-TTY refusal, and `exitOnCtrlC: false`. A zone with an `error` state shows its error text in the diff pane.

Done when: these tests pass on the fake client.
- A frame test shows every inventory zone with the same state word that `statusLines` prints for the same reports.
- A frame test taken before the first report arrives shows every row, with `loading` in STATE.
- After `j`, the diff pane shows the second zone's `diffLines`.
- At 100 columns, a frame test shows one pane, and `tab` switches to the other.
- `R` after a bad edit to `baseline.yaml` shows the parse error in the header and keeps the earlier rows.
- A reducer test passes for each NORMAL, FILTER, and diff pane row of the key map.
- A test shows that `run(['status'])` does not load `ink`.

### Phase 3: dry run and write (built 2026-10-21)

Add `space`, `ctrl-a`, `ctrl-x`, `d`, `a`, CONFIRM mode, RUNNING mode, the skipped-zone lines, the write error display, and the `ctrl-c` rule. After a write, the TUI refreshes that zone and shows the backup path and the outcome text.

Done when: these tests pass on the fake client.
- `d` sends no write call, and the diff pane shows the `planLines` text.
- `a` then `y` writes a backup with the same files as `flarewall apply --write` for the same zone, and the zone then shows `in sync`.
- `a` then `n` sends no write call.
- With two marked zones, `a`, `y`, `esc` writes the first zone only.
- With one of two marked zones hidden by a filter, `a` opens CONFIRM for the visible zone only.
- With a fake that rejects `updatePhase`, `a` then `y` shows the error and the backup path, and the fake zone keeps its earlier rules.
- `ctrl-c` during a write lets that zone's read-back finish before the TUI quits.

### Phase 4: live check

Attended: the owner runs the TUI against live zones. No agent runs a write. This phase comes last because it checks the built TUI; Phases 1 to 3 need nobody.

Done when: the TUI lists every inventory zone with the same state that `flarewall status` prints on the same data repo, and a write from the TUI on a test zone writes the same backup files as the CLI.

## Open questions

None. The grill on 2026-10-21 settled every question.

## Non-goals

- `restore`, `add`, and `init` in the TUI.
- Mouse input, themes, and a key map the owner can edit.
- Writing a token to a file, or a token prompt in the TUI. The token comes from `CLOUDFLARE_API_TOKEN` only.
- Opening the Cloudflare dashboard or copying to the clipboard. The box is headless.
- Any change to what `status`, `diff`, or `apply` decide. The TUI shows the core's answers.
