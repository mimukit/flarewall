# Plan: move the flarewall data from the git data repo to a local SQLite database

Grilled: 2026-10-22

Updated: 2026-10-21. The store is a local SQLite file; Cloudflare D1 moved to a later, optional adapter.

## Context

flarewall keeps its private data in a separate git repo: `baseline.yaml`, one inventory YAML file per zone, backup JSON under `backups/<zone>/<time>/`, and (by plan 0001) drift history as GitHub issues. The owner does not want a git repo to hold and track this data. The owner wants one database that holds the data and records each change as a version.

Success: every command and the TUI read and write one local SQLite file, every edit to the baseline or a zone's inventory is a new revision that can be listed, diffed, and rolled back, the agent skill can propose a change that the owner approves in the TUI, and `flarewall export` writes the whole database to one JSON file that can rebuild it.

This plan supersedes these rows of the plan 0001 Design decisions table: Code and data split (the data location only), Private data store, Active baseline, Drift run, Drift run failure, Data repo path, Backups, and Skill output. It also changes Phase 5 (#2) and Phase 7 (#4) of plan 0001, and the TUI rows in plan 0002 that name the data repo.

## Design decisions (settled)

| Decision | Resolution |
|----------|-----------|
| Store | One local SQLite file, through `node:sqlite`. Owner pick, 2026-10-21. It needs no account, no credential, and no network, and it is the fastest option. Cloudflare D1 is a later, optional adapter (see Non-goals). |
| Storage port | A `DataStore` interface in `src/core/store.ts`, beside `CloudflareApi` in `src/core/api.ts`. The core and the TUI reducer call only the interface, so the core stays free of Node-only APIs, a Worker can run it later, and a D1 adapter can come later with no change to the callers. |
| Adapter | `src/node/sqlite-store.ts` on `node:sqlite`. The schema, the migrations, and every query sit in one SQL module in the SQLite dialect, so a later D1 adapter can run the same SQL. The name `DataStore` keeps it apart from the TUI reducer `Store` in `src/tui/store.ts`. Grill default, 2026-10-22. |
| File location | `FLAREWALL_DB` names the file. With no value, the file is `$XDG_DATA_HOME/flarewall/flarewall.sqlite`, or `~/.local/share/flarewall/flarewall.sqlite` when `XDG_DATA_HOME` is not set. On devaloy that path is on the `/home/dev` volume. The `--data` flag and `FLAREWALL_DATA` go away. When either is set, the command stops with `--data is gone; flarewall reads FLAREWALL_DB`. There is still no config file. |
| File safety | The tool creates the file and its directory with mode `0600` and `0700`, because the file holds private data. It sets the journal mode to `DELETE`, not `WAL`, so a plain copy of the one file while no flarewall command runs is a full backup. It sets a busy timeout of 5 seconds, so a CLI command and an open TUI wait for each other in place of failing. |
| Backup of the file | Manual, by the owner. Owner pick, 2026-10-21. The tool does not copy, sync, or upload the file. `flarewall export` gives a text copy for the owner to store where they choose. |
| Token | `CLOUDFLARE_API_TOKEN` covers the zones only, as today. The README lists every zone permission the tool needs, DNS Read included. |
| Revisions | An append-only `revisions` table for the baseline and each zone's inventory: `id`, `kind` (`baseline` or `inventory`), `zone` (null for the baseline), `parent_id`, `status` (`pending`, `approved`, `rejected`), the YAML text, a SHA-256 of the text, `author`, `message`, `created_at`, and `decided_at`. The current version of a document is its newest `approved` row. No row is updated except `status` and `decided_at` on a pending row. Timestamps are ISO 8601 UTC text from `deps.now`. There is no `decided_by` column. |
| Author | A source word that the command sets: `owner` for `add`, `edit`, `revert`, and the TUI, and `skill` for `propose`. `--author <word>` overrides it on `propose`. Owner pick, 2026-10-22. The OS user and the token user cannot tell the owner from the skill on devaloy, because both run as `dev` with one token. |
| Version history | `flarewall log [zone]` lists the revisions, `flarewall show <id>` prints one, and `flarewall revert <id>` writes a new approved revision with the text of an older one. A revert never deletes a row. |
| Review | Pull request review goes away. Owner pick, 2026-10-21. A proposed change is a `pending` revision. The owner approves or rejects it in the TUI, which shows the YAML diff and the zone diff that the change would cause. `flarewall approve <id>` and `flarewall reject <id>` do the same from the CLI. |
| Propose | `flarewall propose <zone> <file>` and `flarewall propose --baseline <file>` validate the text with the Zod schemas, write a `pending` revision whose parent is the current revision, and print its id. `<file>` can be `-` for stdin. `--message <text>` sets the message. It refuses a zone with no current inventory (`run flarewall add <zone> first`) and a text identical to the current revision (`no change`). The skill uses this command and never opens the database file. Owner pick, 2026-10-22. |
| Stale proposals | A pending revision records its `parent_id`. Approval refuses when the parent is no longer the current revision, with the message `revision <id> is based on <parent>, but the current revision is <current>; propose it again`. The stale check and the status update run in one `BEGIN IMMEDIATE` transaction, so an open TUI and a CLI command cannot both approve on a stale parent. Two pending revisions for one document can exist; after one is approved, the other fails the stale check. `edit`, `add`, and `revert` save even when a pending revision exists, then name the pending ids that are now stale. |
| Editing | `flarewall edit <zone>` and `flarewall edit --baseline` (with an optional `-m <text>` message, no prompt) write the current YAML to a temp file, open `$EDITOR`, validate the result with the existing Zod schemas (`parseInventory`, `parseBaseline` in `src/core/schema.ts`), show the diff, and save an approved revision. An invalid file reopens the editor with the error at the top. An unchanged file saves nothing. The temp file has mode `0600` and is deleted after the edit. |
| Add | `flarewall add <zone>` and the TUI `+` key write an approved inventory revision with the text `newInventoryText` builds today (`src/node/data.ts`). Adding a zone that already has a current revision refuses. |
| Init | `flarewall init` creates the file, applies the schema, and writes the tool default baseline (`src/baseline/default.yaml`) as the first approved baseline revision. It refuses when the file already holds a baseline revision. Every other command stops with `no flarewall database at <path>; run flarewall init` when the file is missing. |
| Backups | A `backups` table: `id`, `zone`, `zone_id`, `created_at`, and the `ZoneBackup` as JSON. The `BackupWriter` type in `src/core/apply.ts` stays; a store-backed writer replaces `createBackupWriter`, and it returns the backup id. `restore <zone> <backup-id>` reads the row. `flarewall backups <zone>` lists them. Every backup row stays; there is no prune. Owner pick, 2026-10-22. |
| Drift history | Manual. Owner pick, 2026-10-21. No schedule, no Worker cron, no GitHub Actions. `flarewall diff` records one `runs` row and one `run_zones` row per zone (state, change count, error text). `--no-record` skips the write. `status`, `apply`, `restore`, and the TUI (`R` included) record nothing. |
| Schema version | A `meta` table holds the schema version. Each command checks it first. An older file gets the missing migrations, applied in order, each in one transaction. A newer file stops the command with `the database schema is newer than this flarewall; upgrade flarewall`. |
| Export and import | `flarewall export <file>` writes every table to one JSON file with the schema version. `flarewall import <file>` loads such a file into an empty database only. Import never merges. This is the text copy for the owner's own backup, and the path to D1 later. The export has a fixed key order and rows ordered by `id`, and `import` keeps the ids and timestamps, so a round trip is byte-identical. Empty means the schema exists and every table has zero rows, so `import` goes into a file that never ran `init`. `export` runs only when the owner runs it, never after each write. Owner pick, 2026-10-22. |
| Start | Start empty. Owner pick, 2026-10-21. No import of the YAML files or the backup directories. The data repo stays on disk, untouched, and the owner removes it when ready. |
| Private data | The database file holds the private data, and it lives outside every repo. The tool repo still never holds account IDs, zone IDs, zone names, host roles, origin IPs, backups, tokens, or a database file. `.gitignore` gets `*.sqlite` so a stray copy never enters the tool repo. Test fixtures keep `example.com` hosts and RFC 5737 addresses. |
| Tests | Vitest, as today. Store tests run against `sqlite-store` on an in-memory database. CLI and TUI tests replace the temp data directory with an in-memory store. No new test runner. |
| Outward actions | The build agent may edit the bodies of issues #2 and #4 in Phase 3 (text and plan link only, labels unchanged). Owner pick, 2026-10-22. |
| Phase order | One issue (#8). The docs phase runs before the TUI phase, so Phases 1 to 3 run unattended and the build stops at Phase 4 for the sketch approval. Owner pick, 2026-10-22. |
| Node version | `node:sqlite` needs Node 22.13 or later without a flag. `engines` moves from `>=22` to `>=22.13`. Owner pick, 2026-10-22. On Node 22 `node:sqlite` prints an `ExperimentalWarning`; the CLI filters that one warning before a dynamic `import('node:sqlite')`, so it never mixes with command output. Node 24.22 prints no warning. The check on Node 22.13 is manual, in Phase 5; CI keeps its single Node 22 job. |
| UI house rules | The plan 0002 rules hold: the fixed state words and colours, every TUI colour in `src/tui/theme.ts`, colour never the only signal, and the hint line names the keys of the current mode. New: the footer shows `db <path>` in place of `data <path>`. |

## Approach

Add the storage port and the SQLite adapter first, behind the existing tests, so every command can move off the data repo while the tests stay green. Then move each command, then the TUI, then the review flow. The live check comes last because it needs the real token.

The plan reuses:

- `src/core/schema.ts` for validation of every revision text, unchanged.
- `newInventoryText` and the zone lookup in `addZone` (`src/node/data.ts`) for `add` and `+`.
- `ZoneBackup`, `BackupWriter`, `restoreZone`, and `applyInventoryZone` in `src/core/apply.ts`; only the writer changes.
- `statusAll` in `src/core/status.ts` and the formatters in `src/cli/format.ts` for the zone diff in the review screen.
- The TUI reducer and effect runner (`src/tui/state.ts`, `src/tui/runner.ts`); the `load` effect reads the store in place of `loadData`.
- `test/fake-api.ts` for the Cloudflare side of every test.

Rejected alternatives:

- Cloudflare D1 now. It is hosted and durable, but it needs D1 permissions on the token, a network call for every read, and an account to hold it. The owner moved it to a later, optional adapter on 2026-10-21. The `Store` interface and the shared SQL keep that path open.
- YAML files in a plain directory with no git. It keeps the file shape, but version history, pending proposals, and drift history each need their own index that SQLite gives for free.
- Keep the git repo and add SQLite for drift history only (the research note's suggestion). The owner rejected the git repo itself.

### Phase 1: storage port, schema, and the SQLite adapter (#8)

- Confirm the Node version where `node:sqlite` needs no flag, and whether it warns on Node 22. Record the answer in the plan's Node version row.
- Add the `Store` interface in `src/core/store.ts`: revisions (current, list, get, add, decide), backups (add, list, get), runs (add, list), and the schema version.
- Add the shared SQL module with the schema and the migrations.
- Add `src/node/sqlite-store.ts`, with the file location, the file modes, the journal mode, and the busy timeout.
- Store tests: append-only revisions, the current revision, the stale-proposal refusal, the schema version check, backup round trips, and the file mode `0600`.

Done when: `pnpm test` passes with the new store tests, and `test/core-purity.test.ts` still passes with `src/core/store.ts` in the core.

### Phase 2: move the CLI to the store (#8)

- Move `flarewall init` to create the file, apply the schema, and write the first baseline revision.
- `status`, `diff`, `apply`, and `restore` read the current revisions from the store. `apply` and `restore` write backups to the store.
- `diff` records a run unless `--no-record` is set.
- Add `add`, `edit`, `propose`, `log`, `show`, `revert`, `approve`, `reject`, `backups`, `export`, and `import`.
- Filter the Node 22 SQLite `ExperimentalWarning` before the dynamic import of `node:sqlite`.
- Remove `--data`, `FLAREWALL_DATA`, `loadData`, and the backup directory code. Update the usage text and the README, including the file location, the manual backup note, and the full token permission list.

Done when: every CLI test runs on an in-memory store with no temp data directory, `FLAREWALL_DB=/tmp/x.sqlite flarewall init` prints the baseline revision id, and `flarewall export` then `flarewall import` into a new file gives a database whose `export` is byte-identical.

### Phase 3: docs and the plan 0001 follow-up (#8)

- Update the superseded rows in the plan 0001 Design decisions table to point to this plan.
- Update the AGENTS.md rule that says the private data lives in a separate data repo.
- Re-scope issue #2 (scheduled drift alert) to the manual `diff` run, and issue #4 (skill) to write a pending revision through `flarewall propose` in place of a pull request. The build agent edits both issue bodies and leaves their labels.

Done when: `grep -rn "data repo" docs/plans/0001* AGENTS.md README.md` shows only lines that point to this plan, and both issues name this plan.

### Phase 4: move the TUI to the store and add the review screen (#8)

Attended: the owner approves the review screen sketch below before the build. The layout stays open until then (owner pick, 2026-10-22).

- The `load` effect reads the store. `R` reloads the current revisions. The footer shows `db <path>`.
- `+` writes an approved inventory revision.
- A `p` key opens the pending revisions. `enter` shows the YAML diff and the zone diff the change would cause. `y` approves and `x` rejects, each after a y/N prompt, as CONFIRM does for a write.
- The header counts show `<n> pending` when a pending revision exists.

Sketch of the review screen:

```
╭ Pending ─────────────────────────────╮╭ #42 example.com inventory, by skill ──────────╮
│ > #42  example.com   skill  2h ago   ││ - hosts.api: []                               │
│   #45  baseline      skill  10m ago  ││ + hosts.api: [api.example.com]                │
│                                      ││                                               │
│                                      ││ Zone diff after approval:                     │
│                                      ││   http_request_firewall_custom: changed ...   │
╰──────────────────────────────────────╯╰───────────────────────────────────────────────╯
 y approve  x reject  esc back  ? help
```

Done when: a frame test approves a pending revision and the zone row then shows the state from the new revision, a frame test rejects one and the revision list shows it as rejected, and the help overlay lists `p`, `y`, and `x`.

### Phase 5: live check (#8)

Attended: the owner runs it with the real token.

- On Node 22.13, run `flarewall --help` and `flarewall log`, and check that stderr shows no `ExperimentalWarning`.

- `flarewall init`, `add` one test zone, `edit` it, `propose` a change and `approve` it, `diff`, `apply` in dry run, then `apply --write` on a test zone, `backups`, `restore` in dry run, `log`, `revert`, and `export`.
- Open the TUI, press `+` on a not managed zone, and check that the new revision shows.
- Copy the database file while no command runs, point `FLAREWALL_DB` at the copy, and run `flarewall log`.

Done when: Node 22.13 prints no warning, each step prints the expected result, `flarewall log <zone>` lists the add, the edit, and the revert in order, the file copy shows the same log, and the export file restores into an empty file.

## Migration and rollback

There is no data migration. The database starts empty, and the existing data repo stays on disk untouched, so the old tool version can still read it. The owner currently has no inventory files, so starting empty loses nothing.

Rollback of the tool: pin the last flarewall version before this plan, which reads the data repo.

Rollback of the data: the owner's own copies of the database file, or `flarewall import` of an export file into a new empty file. The tool keeps no copy itself. On devaloy, the file lives on the `/home/dev` volume, which has no backup job and which `docker compose down -v` deletes, so a copy off the box is the owner's only protection. A schema migration that fails stops the command before any write, because each migration runs in one transaction and the schema version moves only at its end.

## Open questions

- The review screen layout (two panes as sketched, or a third pane for the zone diff) waits on the owner's sketch approval at the start of Phase 4.

## Non-goals

- A Cloudflare D1 adapter. It is a later, optional feature; the `Store` interface, the shared SQL, and `export`/`import` keep the path open.
- Any backup, sync, or upload of the database file by the tool, and an automatic `export` after each write.
- A `prune` command for backups and runs. A later follow-up if the file grows too large.
- A scheduled drift run, a Worker cron trigger, and GitHub Actions. The drift run stays manual.
- An import of the existing YAML files or backup directories.
- A merge of two databases, or an import into a database that is not empty.
- Multi-user access control. One owner and one token.
- A web UI over the database.
