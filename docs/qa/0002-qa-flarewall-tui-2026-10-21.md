# QA Plan: flarewall TUI

_Generated 2026-10-21 · against `36d5282` (clean) · covers `flarewall tui`: Phases 1 to 3 of `docs/plans/0002-plan-flarewall-tui-2026-10-21.md` and the Phase 4 live check_

## Summary
- `flarewall tui` shows every zone, its state, and its diff on one screen, and applies the baseline with the CLI's safety steps.
- Working means the TUI shows the same states as `flarewall status` and a write writes the same backup as `flarewall apply --write`.

## Environment
True for the whole plan. Do this once, before Scenario 1.

- Branch under test: `issue-3-add-a-terminal-ui-over-status-diff-and-apply`.
- The private data repo with at least one test zone that you can change and restore.
- A read-only token for Scenario 1 and a write token for Scenario 2. Export each one in the shell only. Never write a token to a file.
- A real terminal at least 130 columns wide. A tmux pane that you can make narrower is useful for TC-1.3.

Build the branch:

```sh
cd ~/worktrees/flarewall/issue-3-add-a-terminal-ui-over-status-diff-and-apply && pnpm install --frozen-lockfile && pnpm build
```

Set the data repo:

```sh
export FLAREWALL_DATA=<path to the private data repo>
```

- [ ] Environment ready

## Test cases at a glance

Priority legend: 🔴 Critical · 🟡 Normal · 🟢 Low

| # | Scenario | Test case | Priority |
|------|----------|-----------|----------|
| TC-1.1 | 1: Data repo, read-only token | The TUI shows the same states as `flarewall status` | 🔴 Critical |
| TC-1.2 | 1: Data repo, read-only token | The screen matches the approved sketch | 🟡 Normal |
| TC-1.3 | 1: Data repo, read-only token | A narrow terminal shows one pane | 🟢 Low |
| TC-2.1 | 2: Test zone in drift, write token | A TUI write writes the same backup as the CLI | 🔴 Critical |

## Scenario 1: Data repo, read-only token

**Setup.** Run once, for every case in this scenario.

1. Export the read-only token in this shell.

```sh
export CLOUDFLARE_API_TOKEN=<read-only token>
```

- [ ] Setup complete

### TC-1.1: The TUI shows the same states as `flarewall status`  ·  🔴 Critical

**Goal.** The TUI and the CLI report the same state for every zone on live data.

**Steps**

1. Print the CLI states.

   ```sh
   node dist/cli/main.js status
   ```

2. Start the TUI. Wait until no row shows `loading`.

   ```sh
   node dist/cli/main.js tui
   ```

   - [ ] Every zone in the CLI output has a row with the same STATE and the same PLAN
     - the header counts for drift, legacy, and error agree with the CLI output
     - `not managed` zones show `-` in CHANGES, UNOWNED, HOSTS, GEO, and REDIRECT
   - [ ] The rows appear at once, and the states fill in one row at a time
3. Select a `drift` zone with `]`. Compare the diff pane with `node dist/cli/main.js diff <zone>` in a second shell.
   - [ ] The diff pane shows the same changes as the CLI `diff` output
4. Press `q`.
   - [ ] The terminal comes back as it was before the TUI started

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

### TC-1.2: The screen matches the approved sketch  ·  🟡 Normal

**Goal.** The real terminal shows layout A with readable colours and key hints.

**Steps**

1. Start the TUI at 130 columns or wider. Move through the zones with `j` and `k`.
   - [ ] The screen matches the layout A sketch in the plan
     - header, zones pane on the left, diff pane on the right, mode chip and key hints at the bottom
     - state colours: `in sync` green, `drift` yellow, `legacy` magenta, `error` red, `not managed` grey
     - every state also shows as a word
     - screenshot: `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/normal-140.txt` (text frame on a fake client, no colour)
2. Press `?`, then `?` again.
   - [ ] The help overlay is readable and lists the keys of every mode
     - screenshot: `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/help-140.txt`
3. Press `/`, type part of a zone name, then press `enter`. Then press `esc`.
   - [ ] The filter, the FILTER chip, and the key hints are clear
     - screenshot: `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/filter-140.txt`
4. Select a `drift` zone and press `d`.
   - [ ] The plan in the diff pane is easy to read
     - long lines wrap without their indent; decide if that is acceptable
     - screenshot: `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/dryrun-140.txt`

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

### TC-1.3: A narrow terminal shows one pane  ·  🟢 Low

**Goal.** Below about 130 columns the TUI stays usable with one pane.

**Steps**

1. With the TUI open, make the terminal about 100 columns wide.
   - [ ] One pane shows, the header shows `1/2`, and `tab` switches to the diff pane
     - the key hint line is cut at the right edge at 100 columns; decide if that is acceptable
     - screenshot: `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/narrow-100.txt`, `narrow-100-tab.txt`
2. Make the terminal wide again.
   - [ ] Both panes come back with no restart

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

**Reset.** Press `q` to quit the TUI.

## Scenario 2: Test zone in drift, write token

**Setup.** Run once, for every case in this scenario.

1. Make a manual change to one rule of the test zone in the Cloudflare dashboard, so `flarewall status` shows `drift` for it.
2. Export the write token in this shell.

```sh
export CLOUDFLARE_API_TOKEN=<write token>
```

- [ ] Setup complete

### TC-2.1: A TUI write writes the same backup as the CLI  ·  🔴 Critical

**Goal.** A write from the TUI uses the same backup, prompt, and read-back as `flarewall apply --write`.

**Steps**

1. Start the TUI. Select the test zone. Press `d`.
   - [ ] The plan names the rule you changed, and no write happens
2. Press `a`.
   - [ ] The CONFIRM chip and `Apply the baseline to <zone>? [y/N]` show with the plan on screen
     - screenshot: `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/confirm-140.txt`
3. Press `n`.
   - [ ] The zone stays `drift`, and no backup directory is new
4. Press `a`, then `y`.
   - [ ] The diff pane shows the backup path and `applied, read-back in sync`, and the row shows `in sync`
5. Quit with `q`. List the new backup directory.

   ```sh
   ls "$FLAREWALL_DATA/backups/<zone>/"
   ```

   - [ ] The newest directory holds the same file names as a backup from `flarewall apply --write`

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

**Reset.** Put the test zone back to its state before Setup.

```sh
node dist/cli/main.js restore <zone> <backup directory from step 4> --write
```

## Automated verification (by AI agent)
_Checks the agent ran itself. No action needed from the tester; listed here for context and sign-off._

Commands run, in the worktree at `36d5282` (clean):

```sh
pnpm typecheck
```

```sh
pnpm build
```

```sh
pnpm vitest run --reporter=verbose
```

```sh
node dist/cli/main.js tui --data "$(mktemp -d)" < /dev/null
```

```sh
script -qec "env -u CLOUDFLARE_API_TOKEN node dist/cli/main.js tui --data /tmp/empty" /dev/null
```

```sh
node dist/cli/main.js --help
```

```sh
npm pack --dry-run
```

- ✅ `pnpm typecheck` → exit 0
- ✅ `pnpm build` → exit 0; `dist/tui/` holds `app.js`, `keymap.js`, `main.js`, `runner.js`, `state.js`, `store.js`
- ✅ `pnpm vitest run` → 161 of 161 tests pass in 13 files
- ✅ C1 · existing CLI tests and snapshots pass with no edit; `onReport` and `applyInventoryZone` tests are new
- ✅ C2 · `src/cli/run.ts` holds no formatter; its only local function is `message`
- ✅ C3 · `statusAll onReport > calls onReport once for each report statusAll returns, with the same reports`
- ✅ C4 · `TUI frames > shows every inventory zone with the state word that statusLines prints`
- ✅ C5 · `TUI frames > shows every row with loading in STATE before the first report arrives`
- ✅ C6 · `TUI frames > after j, the diff pane shows the second zone's diffLines`
- ✅ C7 · `TUI frames > shows one pane at 100 columns, and tab switches to the other`
- ✅ C8 · `TUI frames > R after a bad edit to baseline.yaml shows the parse error in the header and keeps the earlier rows`
- ✅ C9 · 62 reducer tests in `test/tui-state.test.ts`, one or more per key map row
- ✅ C10 · `tui loading > run(['status']) does not load ink or react`
- ✅ C11 · rendered frame at 140 columns shows the header `ZONE  PLAN  STATE  CHANGES  UNOWNED  HOSTS  GEO  REDIRECT`
- ✅ C12 · `TUI dry run and write > d sends no write call and the diff pane shows the planLines text`
- ✅ C13 · `TUI dry run and write > a then y writes the same backup files as flarewall apply --write, and the zone then shows in sync`
- ✅ C14 · `TUI dry run and write > a then n sends no write call`
- ✅ C15 · `TUI dry run and write > with two marked zones, a, y, esc writes the first zone only`
- ✅ C16 · `TUI dry run and write > with one of two marked zones hidden by a filter, a opens CONFIRM for the visible zone only`
- ✅ C17 · `TUI dry run and write > with a fake that rejects updatePhase, a then y shows the error and the backup path, and the zone keeps its rules`
- ✅ C18 · `TUI dry run and write > ctrl-c during a write lets the read-back finish before the TUI quits`
- ✅ `flarewall tui` with no TTY → `refusing to start the tui: stdin is not a terminal`, exit 2
- ✅ `flarewall tui` with a TTY and no token → `CLOUDFLARE_API_TOKEN is not set; ...`, exit 2
- ✅ `--help` lists `tui` and names it under `CLOUDFLARE_API_TOKEN`
- ✅ `npm pack --dry-run` → the package holds the 12 `dist/tui/` files

### Frame checks
_Rendered with `ink-testing-library` on the built `dist/` and a throwaway fake client (four `example.*` zones). Text frames in `/tmp/qakit/0002-qa-flarewall-tui-2026-10-21/`. The script there is `frames.mjs`._

- ✅ NORMAL at 140 columns → two panes; counts `4 zones  2 drift  0 legacy  1 error`; the error zone shows `403: token cannot read this zone`
- ✅ `j` → the diff pane shows `example.com: drift` and its missing rules
- ✅ 100 columns → one pane, header `1/2`; `tab` → the diff pane
- ✅ `?` → the HELP chip and the key table for every mode
- ✅ `/net` → FILTER chip; one row `example.net`
- ✅ `j`, `d` → plan text `example.com: plan` with `create` and `keep unowned` steps; no write
- ✅ `j`, `a` → CONFIRM chip, `Apply the baseline to example.com? [y/N]`, title `example.com plan (1 of 1)`
- ✅ `a` on a zone over the Free plan rate limit rule count → the zone is skipped with `skipped, over the Free plan limit: ...` and its row shows `error`

## Not covered / needs human judgment
- C19 to C21: live zones, a real token, and colour on a real terminal. The box holds no Cloudflare token. Scenarios 1 and 2 cover them.
- Compatibility across terminal programs (iTerm2, Windows Terminal, tmux): only the tester's terminal is in scope.
- Performance with 50 zones: the fake client has four zones. TC-1.1 shows the real load time.
- Accessibility beyond the rule that every state shows as a word: a terminal UI has no screen-reader labels to check.
- Data and database: the TUI writes only backup files through the CLI's writer; no database exists.

## Overall result
_Tick one when you finish the run, or skip the ticks. Report each failure in the agent session or as a PR comment, and the agent records it here._

- [ ] Pass: every case passed
- [ ] Fail: at least one case failed
- [ ] Partial: cases were skipped or not reached
