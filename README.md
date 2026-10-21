# flarewall

flarewall keeps a set of Cloudflare zones on one security baseline. You write the rules once in a baseline file. flarewall applies them to each zone, checks every zone for drift on a schedule, and shows the state of all zones on one screen.

It targets the Cloudflare Free plan: 5 custom rules, 1 rate limiting rule with a 10 second period, and no `matches` operator.

## Install

flarewall needs Node 22 or later.

```sh
npm install -g flarewall
```

## Setup

- Set `CLOUDFLARE_API_TOKEN` to a Cloudflare user token. flarewall reads the token from this variable only and never writes it to a file. Use a read-only token for `status` and `diff`, and a write token for `apply` and `restore`.
- Set `FLAREWALL_DATA` to the path of your private data repo, or pass `--data <path>` to each command.
- Run `flarewall init` once to copy the default baseline to `<data>/baseline.yaml`, then edit that file.
- Run `flarewall add <zone>` for each zone. It writes `inventory/<account-id>/<zone>.yaml`. Set the host roles in that file before you apply.

## Commands

| Command | What it does |
|---------|--------------|
| `flarewall init` | Copies the default baseline to `<data>/baseline.yaml`. It never overwrites an existing file. |
| `flarewall add <zone>` | Writes an inventory file for a zone with no entry. The zone's proxied hostnames go in as comments. |
| `flarewall status [zone...]` | Prints one row per zone: name, plan, and state (`in sync`, `drift`, `legacy`, `not managed`, or `error`). Covers every zone by default. |
| `flarewall diff [zone...]` | Prints the changes per zone, plus the unowned and legacy rules. Covers every zone by default. |
| `flarewall apply <zone...>` or `flarewall apply --all` | Sends the rendered baseline to the zones. Without `--write` it is a dry run that prints what it would send. |
| `flarewall tui` | Opens the terminal UI: every zone's state and diff on one screen, with dry run, apply, and add keys. Press `?` for the keys. It needs a terminal. |
| `flarewall restore <zone> <backup-dir>` | Sends a backup back to a zone. Without `--write` it is a dry run that prints what it would send. `<backup-dir>` is a path, or a directory name under `<data>/backups/<zone>/`. |

Flags:

- `--data <path>` sets the data repo path and overrides `FLAREWALL_DATA`.
- `--all` makes `apply` cover every inventory zone. `apply` needs zone names or `--all`.
- `--write` makes `apply` and `restore` send the writes. Each zone gets a backup first, then a confirmation prompt, then the writes, then a read-back.
- `--yes` skips the per-zone prompt. With `--write`, no terminal on stdin, and no `--yes`, the command refuses to start.

`apply` keeps every rule that has no `flarewall_` ref, after the flarewall rules. It replaces the rules the old `cf-security-setup.sh` script wrote and keeps their rule `id`. Before any write it checks the Free plan limits (5 custom rules, 1 rate limiting rule, 10 redirect rules) on the total of flarewall and other rules, and skips a zone that would go over. A failure in one zone is reported, and the run continues with the next zone.

Backups go to `<data>/backups/<zone>/<UTC time>/`, for example `20261021T081500Z`, as one JSON file per ruleset phase plus `always_use_https.json`, `browser_check.json`, and `bot_management.json`. flarewall prints the path and never runs git, so commit the backups yourself.

## Exit codes

| Command | 0 | 1 | 2 |
|---------|---|---|---|
| `status`, `diff` | every zone in sync or not managed | a zone has drift or legacy rules | an error, such as an API failure or a bad data file |
| `apply`, `restore` | every zone succeeded or was declined | not used | a zone failed (limit, API error, read-back mismatch), or a usage error |
| `init`, `add` | done | not used | an error |
| `tui` | quit, and no write failed | not used | a write failed, or stdin is not a terminal |

## Status

Version 0.1.0 covers `init`, `add`, `status`, `diff`, `apply`, `restore`, and `tui`. The plan is in [docs/plans/0001-plan-flarewall-2026-10-21.md](docs/plans/0001-plan-flarewall-2026-10-21.md), and the TUI plan is in [docs/plans/0002-plan-flarewall-tui-2026-10-21.md](docs/plans/0002-plan-flarewall-tui-2026-10-21.md). A scheduled drift check comes later.

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

This repo holds code and a generic default baseline. Your zone inventory, host roles, origin IPs, and backups go in a separate private repo that you point flarewall at. That repo can also run the scheduled drift check as a GitHub Actions workflow and open one issue per drifted zone.

## Tokens

flarewall reads a Cloudflare API token from `CLOUDFLARE_API_TOKEN` and never writes it to a file. A `wrangler` or `cf` login will not work, since those OAuth scopes have no access to WAF rules, zone settings, or Bot Management.

Plan on two user tokens. A read-only one covers `status`, `diff`, and the scheduled check. A write token, kept on your own machine, covers `apply` and `restore`.

## Stack

TypeScript on Node 22 or later, the official [`cloudflare`](https://github.com/cloudflare/cloudflare-typescript) SDK, Zod for the baseline and inventory schemas, and [Ink](https://github.com/vadimdemedes/ink) for the terminal UI.
