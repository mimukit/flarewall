# QA Plan: SQLite data store (issue #8, Phases 1 to 3)

_Generated 2026-10-22 · against `efe52e5` (clean) · covers the `DataStore` port, the SQLite adapter, every CLI command on the store, the minimal TUI move, and the docs and issue follow-up_

## Summary
- flarewall keeps the baseline, the zone inventories, the backups, and the drift runs in one local SQLite file, and every edit is a revision.
- Working means every command reads and writes that file, revisions are append-only, a stale proposal cannot be approved, and an export round trip is byte-identical.

## Environment
True for the whole plan. Do this once, before Scenario 1.

- Branch: `issue-8-keep-flarewall-data-in-a-local-sqlite-database` at `efe52e5` or later.
- Build the CLI once.
- Use a scratch database file. Never point `FLAREWALL_DB` at a file that holds real data for Scenario 1.

```sh
pnpm install && pnpm build
```

```sh
export FLAREWALL_DB=/tmp/flarewall-qa/flarewall.sqlite
```

- [ ] Environment ready

## Test cases at a glance

Priority legend: 🔴 Critical · 🟡 Normal · 🟢 Low

| # | Scenario | Test case | Priority |
|------|----------|-----------|----------|
| TC-1.1 | 1: Scratch database with the default baseline | Edit the baseline in a real editor | 🔴 Critical |
| TC-1.2 | 1: Scratch database with the default baseline | An invalid edit reopens with the error at the top | 🟡 Normal |
| TC-1.3 | 1: Scratch database with the default baseline | The README explains the file, the backup, and the token | 🟡 Normal |
| TC-2.1 | 2: Node 22.13 and a read-only token | No ExperimentalWarning on Node 22.13 | 🔴 Critical |
| TC-2.2 | 2: Node 22.13 and a read-only token | The read-only token permissions are enough | 🟡 Normal |

## Scenario 1: Scratch database with the default baseline

**Setup.** Run once, for every case in this scenario.

1. Create the scratch database.

```sh
node dist/cli/main.js init
```

- [ ] Setup complete

### TC-1.1: Edit the baseline in a real editor  ·  🔴 Critical

**Goal.** The owner can change the baseline in their own editor and see the change saved as a new revision.

**Steps**

1. Open the baseline in your editor.

   ```sh
   node dist/cli/main.js edit --baseline -m "qa edit"
   ```

   - [ ] Your editor opens with the baseline YAML, and nothing else is in the file
2. Add the line `# qa` at the end. Save and close the editor.
   - [ ] The terminal shows a short diff with `+ # qa`, then `saved baseline revision 2`
     - the diff is readable: one line of context, `...` for skipped lines
3. List the revisions.

   ```sh
   node dist/cli/main.js log
   ```

   - [ ] The log reads clearly as a history: revision 1 by `owner` with `flarewall init`, revision 2 by `owner` with `qa edit`

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

### TC-1.2: An invalid edit reopens with the error at the top  ·  🟡 Normal

**Goal.** A bad edit never saves, and the error message tells the owner what to fix.

**Steps**

1. Open the baseline again.

   ```sh
   node dist/cli/main.js edit --baseline
   ```

2. Change `version: 1` to `version: 2`. Save and close the editor.
   - [ ] The editor opens again, and the lines at the top that start with `# flarewall:` explain the error in words you can act on
3. Delete every line in the file. Save and close the editor.
   - [ ] The terminal shows `baseline: the file was emptied; nothing saved`

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

### TC-1.3: The README explains the file, the backup, and the token  ·  🟡 Normal

**Goal.** A new owner can set up the database and the tokens from the README alone.

**Steps**

1. Read the sections "Setup", "The database file", and "Tokens" in `README.md`.
   - [ ] A new owner can find where the file lives, how to back it up by hand, and which token permissions to grant
     - the default path and `FLAREWALL_DB`
     - the plain copy while no command runs, and `export` / `import`
     - the permission table, DNS Read included, and the note that the phase read permission is not yet checked live

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

**Reset.** Run after every case above, before moving to Scenario 2.

```sh
rm -rf /tmp/flarewall-qa
```

## Scenario 2: Node 22.13 and a read-only token

This scenario overlaps the attended Phase 5 live check of issue #8. Run it there if you prefer.

**Setup.** Run once, for every case in this scenario.

1. Switch to Node 22.13 in this shell.
2. Set `CLOUDFLARE_API_TOKEN` to a read-only token for one test zone.

```sh
export FLAREWALL_DB=/tmp/flarewall-qa/flarewall.sqlite && node --version
```

- [ ] Setup complete

### TC-2.1: No ExperimentalWarning on Node 22.13  ·  🔴 Critical

**Goal.** On Node 22.13 the `node:sqlite` warning never mixes with command output.

**Steps**

1. Run the help and the log, and keep only stderr.

   ```sh
   node dist/cli/main.js --help 2>&1 >/dev/null | grep -c ExperimentalWarning
   ```

   ```sh
   node dist/cli/main.js init && node dist/cli/main.js log 2>&1 >/dev/null | grep -c ExperimentalWarning
   ```

   - [ ] Both commands print `0`

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

### TC-2.2: The read-only token permissions are enough  ·  🟡 Normal

**Goal.** A token with the README read permissions runs `add`, `status`, and `diff` on a live zone.

**Steps**

1. Add the test zone, then run a status and a diff. Replace `example.com` with your test zone.

   ```sh
   node dist/cli/main.js add example.com
   ```

   ```sh
   node dist/cli/main.js status example.com
   ```

   ```sh
   node dist/cli/main.js diff example.com
   ```

   - [ ] No command fails with a 403; if one does, write the failing phase in Notes so the README table can name the exact permission

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _what actually happened on a fail; why it was skipped_

**Reset.**

```sh
rm -rf /tmp/flarewall-qa
```

## Automated verification (by AI agent)
_Checks the agent ran itself at `efe52e5` (clean) on Node 24.22. No action needed from the tester; listed here for context and sign-off._

Commands run (one per block; chain with `&&` when they must run together):

```sh
pnpm typecheck
```

```sh
pnpm test
```

```sh
pnpm build
```

```sh
npm pack --dry-run
```

```sh
pnpm vitest run test/store.test.ts test/core-purity.test.ts --reporter=verbose
```

```sh
bash /tmp/qa8/cli.sh
```

```sh
grep -rn "data repo" docs/plans/0001* AGENTS.md README.md
```

```sh
gh issue view 2 --json labels,body
```

```sh
gh issue view 4 --json labels,body
```

The `cli.sh` script runs the built CLI against a new temp file: `init` twice, `propose --baseline -` three times, `approve`, `reject`, `revert`, `log`, `export`, `import` into a second file, `export` again, a plain copy of the file, and the `--data`, `FLAREWALL_DATA`, missing-file, and no-token refusals.

- ✅ C1, C3 · `pnpm typecheck` → exit 0. `test/core-purity.test.ts` passes for `store.ts`, `store-sql.ts`, and `revisions.ts`.
- ✅ C2 · `test/store.test.ts` → 15 of 15 pass: append-only rows (DELETE and UPDATE refused by triggers), the current revision, the stale refusal for two proposals and after an owner edit, the schema version (newer file refused, empty file migrated), backup and run round trips, mode `0600` file in a `0700` directory, the `DELETE` journal, and the export round trip.
- ✅ C13 · `pnpm test` → 16 files, 225 tests pass, the TUI frame tests included. `pnpm build` → exit 0. `npm pack --dry-run` → exit 0, 54 files, no `.sqlite` file.
- ✅ C4 · `init` → `baseline revision 1 written to <file>`, exit 0. A second `init` → exit 2, `the database at <file> already holds a baseline; flarewall init does not overwrite it`.
- ✅ C6 · `propose --baseline -` with an unchanged text → exit 2, `baseline: no change`. With a changed text → `pending revision 2`, then `pending revision 3`.
- ✅ C6 · `approve 3` → `approved revision 3 (baseline)`. `approve 2` → exit 2, `revision 2 is based on 1, but the current revision is 3; propose it again`. `reject 2` → `rejected revision 2 (baseline)`. `revert 1` → `saved baseline revision 4`.
- ✅ C6 · `log` → four rows in id order with status, author (`owner`, `skill`), and message (`flarewall init`, `tune`, `revert to 1`).
- ✅ C7 · `export`, `import` into a new file, `export` again → `cmp` reports the two JSON files byte-identical. The export file has mode `600`.
- ✅ C8 · a missing file → exit 2, `no flarewall database at <file>; run flarewall init`. `--data /x` and `FLAREWALL_DATA=/x` → exit 2, `--data is gone; flarewall reads FLAREWALL_DB`.
- ✅ Data and state · a plain copy of the file while no command runs gives the same `log` output as the original.
- ✅ C5, C6 · `test/status.test.ts`, `test/apply.test.ts`, and `test/revisions-cli.test.ts` run every zone and revision command on an in-memory store: `diff` records one run with a row per zone, `diff --no-record` and `status` record nothing, `apply --write` and `restore --write` store backups 1 and 2, `restore` refuses another zone's backup, `add` writes revision 2 by `owner` and refuses a second add, and `edit` reopens an invalid file and names stale pending ids.
- ✅ C9 · `README.md` names `FLAREWALL_DB` and `~/.local/share/flarewall/flarewall.sqlite`, has a "Back it up yourself" list, and has a permission table with DNS Read.
- ✅ C10 · the grep finds 10 lines that name the data repo, and 0 of them lack a pointer to plan 0003.
- ✅ C11 · issue #2 → labels `stacked,high` unchanged, body names plan 0003 and the manual drift run. Issue #4 → labels `blocked,medium` unchanged, body names plan 0003 and `flarewall propose`.
- ✅ C12 · `package.json` engines → `>=22.13`. `dist/cli/main.js` calls `quietSqliteWarning()` before `run`, and only `src/node/sqlite-store.ts` imports `node:sqlite`, through a dynamic import in `run.ts`. `isSqliteWarning` has a unit test. The Node 22.13 run itself is TC-2.1.
- ✅ C13 · a probe frame test (removed after the run) renders the TUI on an in-memory store, and the footer shows `db :memory:`.
- ✅ C14 · `.gitignore` line 33 is `*.sqlite`. `git ls-files` lists no `.sqlite` file.

### Browser checks
_No browser checks. flarewall is a CLI and a terminal UI; the TUI frame tests cover the screen._

## Not covered / needs human judgment
- The TUI review screen (`p`, `y`, `x`) and the pending count: issue #8 Phase 4, attended, not built in this run.
- The live check with a real token (`apply --write` on a test zone, `restore`, the TUI `+` on a live zone): issue #8 Phase 5, attended. TC-2.2 covers the read half only.
- Node 22.13: this box has Node 24.22 and Node 20 only, so the agent could not run TC-2.1.
- Concurrency: the 5-second busy timeout and the `BEGIN IMMEDIATE` stale check are in the code, but no test runs two processes at once.
- Performance: not covered. The store holds small YAML texts and one row per backup and run.
- Accessibility and compatibility: no new UI beyond the footer text.
- Security: the file and export modes are checked above. A shared-host permission review is out of scope; the box has one user.

## Overall result
_Tick one when you finish the run, or skip the ticks. Report each failure in the agent session or as a PR comment, and the agent records it here._

- [ ] Pass: every case passed
- [ ] Fail: at least one case failed
- [ ] Partial: cases were skipped or not reached
