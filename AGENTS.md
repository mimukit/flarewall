# AGENTS.md

## What this project is

flarewall keeps a set of Cloudflare zones on one security baseline. It applies a baseline file to each zone, checks every zone for drift on a schedule, and shows all zones on one screen. It targets the Cloudflare Free plan.

The plan is `docs/plans/0001-plan-flarewall-2026-10-21.md`. Its Design decisions table is the source of truth for the stack and the architecture. Read it before you change either.

## Stack

- TypeScript on Node 22 or later, published to npm as `flarewall`.
- The official `cloudflare` SDK, pinned to an exact 7.x version. Security Events use one raw `fetch` to the GraphQL endpoint.
- Zod 4 for the baseline and inventory schemas.
- Vitest for tests, with snapshot tests for the `render` step.
- Ink 8 for the TUI. Only the `tui` command loads it.

## Build and test

- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test` (update render snapshots with `pnpm test -u` only after you check the change)
- Build: `pnpm build` (compiles `src/` to `dist/` and copies `src/baseline/default.yaml` to `dist/baseline/`)
- Private string check: `FLAREWALL_PRIVATE_STRINGS='<one string per line>' pnpm check:private`
- Package contents: `npm pack --dry-run`

## Rules for agents

- Never put private data in this repo: account IDs, zone IDs or names, client names, host roles, origin IPs, backups, or tokens. That data lives in a separate private data repo. Test fixtures use `example.com` hosts and RFC 5737 IP addresses.
- Never write a Cloudflare token to a file. The tool reads it from `CLOUDFLARE_API_TOKEN` only.
- Never run `apply` with the write flag against a live zone. The owner runs writes.
- Keep the core free of logic in the TUI or the skill. Both call the core.
- Keep the core free of Node-only APIs, so a Worker can run it later.
- Every rule flarewall creates carries a `ref` that starts with `flarewall_`. Never delete or rewrite a rule without that prefix.

## Docs artifact naming

- An artifact under `docs/<type>/` (a plan, a QA plan, a review, research) is named `NNNN-<type>-<slug>-YYYY-MM-DD.md`.
- `NNNN` is a four-digit serial, per directory, assigned in creation order and never reused. To get it, take the highest serial in that directory across this worktree, every other worktree that `git worktree list` names, and `origin/HEAD` (`git ls-tree --name-only origin/HEAD <dir>` after `git fetch origin`), and add one. Scan all three, because parallel worktrees otherwise take the same serial. Skip a source that fails, such as no remote, and without git list the directory only. An empty directory starts at `0001`.
- `YYYY-MM-DD` is the creation date. The whole name stays fixed after edits.
- An ADR uses its decision number as the serial: `docs/adr/NNNN-adr-<slug>-YYYY-MM-DD.md`.
- Reader-facing pages (`docs/wiki/`, how-to guides, runbooks) stay unnumbered.
