# flarewall

flarewall keeps a set of Cloudflare zones on one security baseline. You write the rules once in a baseline file. flarewall applies them to each zone, checks every zone for drift on a schedule, and shows the state of all zones on one screen.

It targets the Cloudflare Free plan: 5 custom rules, 1 rate limiting rule with a 10 second period, and no `matches` operator.

## Status

Planning. There is no code yet, and nothing installs. The plan is in [docs/plans/0001-plan-flarewall-2026-10-21.md](docs/plans/0001-plan-flarewall-2026-10-21.md), and the research behind its decisions is in [docs/research/0001-research-flarewall-open-questions-2026-10-21.md](docs/research/0001-research-flarewall-open-questions-2026-10-21.md).

## Planned commands

| Command | What it does |
|---------|--------------|
| `flarewall status` | Prints one row per zone: plan, and whether the zone is in sync or has drifted. |
| `flarewall diff` | Prints the changes between each zone's live state and its rendered baseline. |
| `flarewall apply` | Sends the baseline to a zone. It is a dry run unless you pass the write flag. |
| `flarewall tui` | Opens a terminal UI over `status`, `diff`, and `apply`. |

`apply` backs up the current rulesets and zone settings before it writes. It asks for confirmation per zone, then reads back what it sent. A failure in one zone does not stop the others. Rollback means restoring that backup.

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

Plan on two user tokens. A read-only one covers `status`, `diff`, and the scheduled check. A write token, kept on your own machine, covers `apply`.

## Stack

TypeScript on Node 22 or later, the official [`cloudflare`](https://github.com/cloudflare/cloudflare-typescript) SDK, Zod for the baseline and inventory schemas, and [Ink](https://github.com/vadimdemedes/ink) for the terminal UI.
