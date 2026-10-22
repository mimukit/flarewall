# flarewall

flarewall keeps a set of Cloudflare zones on one security baseline. You write the rules once in a baseline file. flarewall applies them to each zone, checks every zone for drift when you run `flarewall diff`, and shows the state of all zones on one screen. It keeps the baseline, each zone's inventory, the backups, and the drift history in one local SQLite file, and every edit is a revision you can list, diff, and roll back.

It targets the Cloudflare Free plan: 5 custom rules, 1 rate limiting rule with a 10 second period, and no `matches` operator.

## Install

flarewall needs Node 22.13 or later, for `node:sqlite`.

```sh
npm install -g flarewall
```

## Setup

- Set `CLOUDFLARE_API_TOKEN` to a Cloudflare user token. flarewall reads the token from this variable only and never writes it to a file. Use a read-only token for `status` and `diff`, and a write token for `apply` and `restore`.
- Run `flarewall init` once. It creates the database file and writes the default baseline as revision 1. Change the baseline with `flarewall edit --baseline`.
- Run `flarewall add <zone>` for each zone. It writes the zone's first inventory revision. Set the host roles with `flarewall edit <zone>` before you apply.

## Commands

| Command | What it does |
|---------|--------------|
| `flarewall init` | Creates the database file and writes the default baseline as the first revision. It refuses when the file already holds a baseline. |
| `flarewall add <zone>` | Writes the first inventory revision for a zone with no entry. The zone's proxied hostnames go in as comments. |
| `flarewall status [zone...]` | Prints one row per zone: name, plan, and state (`in sync`, `drift`, `legacy`, `not managed`, or `error`). Covers every zone by default. |
| `flarewall diff [zone...]` | Prints the changes per zone, plus the unowned and legacy rules. Covers every zone by default. It records the run (one row per zone) unless you pass `--no-record`. |
| `flarewall apply <zone...>` or `flarewall apply --all` | Sends the rendered baseline to the zones. Without `--write` it is a dry run that prints what it would send. |
| `flarewall tui` | Opens the terminal UI: every zone's state and diff on one screen, with dry run, apply, and add keys. Press `?` for the keys. It needs a terminal. |
| `flarewall restore <zone> <backup-id>` | Sends a stored backup back to a zone. Without `--write` it is a dry run that prints what it would send. |
| `flarewall backups <zone>` | Lists the stored backups of a zone, with their ids. |

Revision commands:

| Command | What it does |
|---------|--------------|
| `flarewall edit <zone>` or `flarewall edit --baseline` | Opens the current text in `$EDITOR` (`$VISUAL` first). An invalid file opens again with the error at the top; an empty file cancels. flarewall prints the diff and saves an approved revision. |
| `flarewall propose <zone> <file>` or `flarewall propose --baseline <file>` | Writes a pending revision for the owner to approve and prints its id. `<file>` can be `-` for stdin. The agent skill uses this command and never opens the database file. |
| `flarewall approve <id>` and `flarewall reject <id>` | Decide a pending revision. Approval refuses a revision whose parent is no longer the current revision; propose it again. |
| `flarewall log [zone]` | Lists the revisions, oldest first: id, time, document, status, author, and message. |
| `flarewall show <id>` | Prints one revision: a comment header, then the YAML text. |
| `flarewall revert <id>` | Saves the text of an older approved revision as a new revision. Nothing is deleted. |
| `flarewall export <file>` | Writes every table to one JSON file, with mode 0600. It never overwrites a file. |
| `flarewall import <file>` | Loads an export file into an empty database only. It never merges. |

Flags:

- `--all` makes `apply` cover every inventory zone. `apply` needs zone names or `--all`.
- `--write` makes `apply` and `restore` send the writes. Each zone gets a backup first, then a confirmation prompt, then the writes, then a read-back.
- `--yes` skips the per-zone prompt. With `--write`, no terminal on stdin, and no `--yes`, the command refuses to start.
- `--no-record` makes `diff` skip the run record.
- `--baseline` makes `edit` and `propose` work on the baseline in place of a zone inventory.
- `-m <text>` or `--message <text>` sets the revision message for `edit`, `propose`, and `revert`.
- `--author <word>` sets the author on `propose`. It defaults to `skill`; `add`, `edit`, `revert`, and the TUI write `owner`.

`apply` keeps every rule that has no `flarewall_` ref, after the flarewall rules. It replaces the rules the old `cf-security-setup.sh` script wrote and keeps their rule `id`. Before any write it checks the Free plan limits (5 custom rules, 1 rate limiting rule, 10 redirect rules) on the total of flarewall and other rules, and skips a zone that would go over. A failure in one zone is reported, and the run continues with the next zone.

Each backup is one row in the database: the zone's ruleset phases, `always_use_https`, `browser_check`, and Bot Fight Mode as JSON. flarewall prints the backup id. Every backup stays; there is no prune.

## The database file

flarewall reads and writes one SQLite file. `FLAREWALL_DB` names it. With no value, the file is `$XDG_DATA_HOME/flarewall/flarewall.sqlite`, or `~/.local/share/flarewall/flarewall.sqlite` when `XDG_DATA_HOME` is not set. `--data` and `FLAREWALL_DATA` are gone; setting either stops the command.

The file holds your private data, so flarewall creates it with mode `0600` in a directory with mode `0700`. Keep it out of every git repo; this repo's `.gitignore` lists `*.sqlite`.

flarewall never copies, syncs, or uploads the file. Back it up yourself:

- While no flarewall command runs, a plain copy of the one file is a full backup. The file uses the `DELETE` journal mode, so there is no side file to miss.
- `flarewall export <file>` writes a JSON text copy. `flarewall import <file>` rebuilds a database from it in a new, empty file.

A CLI command and an open TUI wait up to 5 seconds for each other's lock.

## Exit codes

| Command | 0 | 1 | 2 |
|---------|---|---|---|
| `status`, `diff` | every zone in sync or not managed | a zone has drift or legacy rules | an error, such as an API failure or a bad data file |
| `apply`, `restore` | every zone succeeded or was declined | not used | a zone failed (limit, API error, read-back mismatch), or a usage error |
| `init`, `add`, and the revision commands | done | not used | an error, a refusal, or a usage error |
| `tui` | quit, and no write failed | not used | a write failed, or stdin is not a terminal |

## Status

The plan is in [docs/plans/0001-plan-flarewall-2026-10-21.md](docs/plans/0001-plan-flarewall-2026-10-21.md), the TUI plan is in [docs/plans/0002-plan-flarewall-tui-2026-10-21.md](docs/plans/0002-plan-flarewall-tui-2026-10-21.md), and the SQLite data store plan is in [docs/plans/0003-plan-d1-data-store-2026-10-21.md](docs/plans/0003-plan-d1-data-store-2026-10-21.md). The drift check is manual: run `flarewall diff`. The TUI review screen for pending revisions comes later; until then, use `flarewall approve` and `flarewall reject`.

## What the baseline covers

- Block requests to non-standard edge ports.
- Block scanner probes such as `.env`, `/.git`, and `phpinfo`, with exceptions for API hosts and WordPress hosts.
- Challenge traffic from hosting networks, by ASN.
- Challenge traffic from outside one country (optional per zone, off by default).
- A rate limit per IP.
- Redirect rules for HTTP to HTTPS and for www or non-www.
- `always_use_https`, Browser Integrity Check, and Bot Fight Mode where the zone's hosts allow it.

flarewall owns only the rules it creates. Each one carries a `ref` that starts with `flarewall_`. A rule you made by hand in the dashboard stays in place, and `diff` lists it as unowned instead of as drift.

## Your data stays out of this repo

This repo holds code and a generic default baseline. Your zone inventory, host roles, origin IPs, backups, and drift history live in the database file, outside every repo. See [the database file](#the-database-file).

## Tokens

flarewall reads a Cloudflare API token from `CLOUDFLARE_API_TOKEN` and never writes it to a file. A `wrangler` or `cf` login will not work, since those OAuth scopes have no access to WAF rules, zone settings, or Bot Management.

Plan on two user tokens, each scoped to the zones you manage. A read-only one covers `add`, `status`, `diff`, and the TUI without writes. A write token, kept on your own machine, covers `apply` and `restore`.

| Permission | Read-only token | Write token | Used by |
|------------|-----------------|-------------|---------|
| Zone Read | yes | yes | every zone command: the zone list and plan |
| DNS Read | yes | yes | `add` (proxied hostnames), and every check, which renders the rules from the zone's DNS records |
| Zone WAF | Read | Edit | the custom rules and rate limiting rule phases |
| Single Redirect (Dynamic URL Redirects) | Read | Edit | the redirect rules phase |
| Zone Settings | Read | Edit | `always_use_https` and Browser Integrity Check |
| Bot Management | Read | Edit | Bot Fight Mode |

The exact rulesets permission for a zone-level phase read is not yet checked against a live zone. If a read fails with a 403, the error names the phase; add the matching rulesets permission.

## Stack

TypeScript on Node 22.13 or later, `node:sqlite` for the data store, the official [`cloudflare`](https://github.com/cloudflare/cloudflare-typescript) SDK, Zod for the baseline and inventory schemas, and [Ink](https://github.com/vadimdemedes/ink) for the terminal UI.
