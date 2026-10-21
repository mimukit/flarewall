# Plan: flarewall, a security baseline tool for Cloudflare zones

Grilled: 2026-10-21

## Context

The owner runs a technical consultancy that manages websites and services for mostly non-technical clients. The client zones sit in 10 to 50 Cloudflare zones across several accounts, and a new zone arrives about once a month. Scanner and bot traffic hits these zones thousands of times a day. On 2026-10-13, hosting networks sent 821 of 848 mitigated requests on one zone.

Today the protection comes from `cf-security-setup.sh`, a 387-line bash script in a private repo, with its own plan there. The script applies a fixed rule set per zone, with a dry run by default, a backup, and a read-back. It cannot show the state of all zones on one screen, it cannot detect drift, and each rule change from traffic analysis is a manual edit of the script.

flarewall replaces the script with one tool that does three jobs: apply a baseline to a zone, watch all zones for drift from that baseline, and tune the baseline from Security Events. The owner is the first and only user. The package is public on npm under the MIT license from its first release, so the code must hold no personal or client data.

Success means the owner sees every zone and its drift state in one view, brings a new zone to the baseline with `flarewall add`, a role edit, and `flarewall apply`, and gets an alert when a zone drifts, with no edit to tool code.

## Design decisions (settled)

| Decision | Resolution |
|----------|-----------|
| Name | `flarewall` for the repo, the CLI command, and the npm package. Checked on 2026-10-21: the npm name and the GitHub handle are free. The skill also takes the name `flarewall` and ships in this repo. |
| User | The owner only. Team features, shared logins, and a client view are out of scope for now. |
| Architecture | One core with three commands: `status`, `diff`, and `apply`. The TUI and the agent skill are front ends that call the core and hold no logic of their own. |
| Baseline as data | The rule set lives in a baseline file, not in code. A rule change is an edit to that file, and the core turns it into Cloudflare API calls. |
| Code and data split | The tool repo holds code and a generic default baseline only. The default is a seed and a test fixture, not the baseline that zones use. Account IDs, zone names, host roles, origin IPs, backups, and tokens never enter this repo. They live in a separate private data repo. |
| Secrets | A token comes from the `CLOUDFLARE_API_TOKEN` environment variable. A Cloudflare login does not work, because the `wrangler` and `cf` OAuth scopes have no WAF, zone settings, Bot Management, or analytics access. Use a read-only user token for `status`, `diff`, and the drift run, and a write token for `apply` on the owner's machine. The tool never writes a token to a file. |
| Safe by default | `apply` runs as a dry run unless the owner passes an explicit flag. It backs up the current state before a write, asks for confirmation per zone, and reads back what it sent. This keeps the behaviour of the current script. |
| Drift check | A scheduled run of `diff` with no AI in the path. A daily check of 50 zones must be cheap and give the same answer every run. |
| Skill role | The skill reads Security Events and proposes an edit to the baseline or to a zone's host roles. It never applies a change. The owner reviews the edit, and `apply` sends it. |
| Rule set source | The first baseline ports the rule set from the current script: edge port block, probe block with host-role exceptions, hosting ASN challenge, optional geo challenge, rate limit, redirect rules, `always_use_https`, `browser_check`, and Bot Fight Mode with its zone-wide limits. |
| Plan limits | The baseline targets the Cloudflare Free plan: 5 custom rules, 1 rate limiting rule with a fixed 10 s period, no `matches` operator. |
| Official security-audit skill | `cloudflare/security-audit-skill` audits repository code, not zone settings. flarewall does not depend on it. |
| Runtime | TypeScript on Node 22+, published as the npm package `flarewall`. Zod 4 validates the baseline and the inventory. Vitest snapshot tests cover `render`. The core uses no Node-only API, so a Worker can run it later. |
| API layer | The official `cloudflare` TypeScript SDK, pinned to an exact 7.x version. Security Events use one raw `fetch` to the GraphQL endpoint. The `cf` CLI and `wrangler` are not used. |
| TUI library | Ink 8. Only the `tui` command loads it, so the CLI and the drift run stay at about 90 MB RSS and the TUI peaks at about 130 MB. |
| Terraform | Rejected. Open provider bugs give perpetual diffs on imported rulesets, and since v5.25.0 `plan` needs write access. |
| Private data store | One private GitHub repo holds the zone inventory as YAML, the backups as JSON, and the drift workflow. GitHub issues hold the drift history. The tool reads the data repo path from config or the environment. |
| Active baseline | The active baseline is `<data>/baseline.yaml` in the private data repo. `flarewall init` copies the tool default there once. Skill pull requests, `diff`, and the drift run all read that file. |
| Baseline shape | One baseline for all zones. Each inventory entry sets parameters only: host roles, geo on or off and its country, redirect mode, and an optional rate limit. Bot Fight Mode and Browser Integrity Check stay derived from the host roles. |
| Rule ownership | Every flarewall rule carries a `ref` with the prefix `flarewall_`, and `apply` keeps the existing rule `id`. `apply` keeps rules with no `flarewall_` ref after the owned rules, and `diff` reports them as unowned, not as drift. This protects hand-made rules and keeps the rule link in Security Events. |
| Legacy adoption | The core knows the rule descriptions that `cf-security-setup.sh` writes and its `cf_security_canonical_host` ref. It treats those rules as owned, and `diff` reports them as `legacy`, not as unowned. The first `apply` replaces them with `flarewall_` rules and keeps their `id`. This stops a script-hardened zone from getting 8 custom rules against the limit of 5. |
| Zone onboarding | `flarewall add <zone>` writes an inventory file with the zone ID, no host roles, and the zone's hostnames as comments. The owner sets the roles. `status` lists every account zone with no inventory entry as `not managed`. No zone is managed without an inventory file. |
| Paid-plan zones | The same Free-plan baseline applies. `status` shows the zone plan. Paid features wait until a paid zone needs one. |
| Drift run | A scheduled GitHub Actions workflow in the private data repo, with a read-only user token that has an expiry date. The run backs off on HTTP 429. It installs an exact `flarewall@X.Y.Z`, and a version bump is a pull request on the data repo. |
| Drift run failure | A failed run (expired token, API error) fails the workflow and opens one issue labelled `drift-run-failed`. The next good run closes it. A failure never reads as "no drift". |
| Alert channel | One GitHub issue per drifted zone, labelled `drift` and the zone name, with the diff in the body. The run updates the issue on new drift and closes it when the zone is in sync. |
| Open-source strip | Every local choice is a parameter with a neutral default: the geo rule is off by default and needs a country. Fixtures use `example.com` and RFC 5737 addresses. CI fails on a private string list and runs gitleaks. Phase 2 adds this CI, and it must pass before any publish. |
| Distribution and license | Published to public npm as `flarewall` under the MIT license. The repo `LICENSE` changes from proprietary to MIT before the first publish. `package.json` has a `files` allowlist so only `dist/` and the license ship. The owner runs `npm publish` by hand after the strip CI and `npm pack --dry-run` pass. No agent and no CI job publishes, and the tool repo holds no `NPM_TOKEN`. |
| CLI surface | `apply` and `restore` are dry runs unless the owner passes `--write`. `--yes` skips the per-zone prompt. With no TTY and no `--yes`, a write refuses to start. `status` and `diff` cover all inventory zones by default. `apply` and `restore` need zone names or `--all`. `diff` exits 0 when in sync, 1 on drift, and 2 on error. |
| Drift meaning | Drift is a missing, extra, or changed owned rule (expression, action, action parameters, `enabled`, or order among owned rules), a changed zone setting, or a changed Bot Fight Mode value. The comparison uses an allowlist of fields, so fields the API adds never count. Unowned rules show on their own line. |
| Rule limits | When owned plus unowned rules exceed a Free-plan limit, `apply` skips that zone with an error and continues with the other zones. |
| Data repo path | The `FLAREWALL_DATA` environment variable or the `--data` flag. There is no config file. |
| Backups | `apply` and `restore` write the backup files and print their path. They do not run git. The owner commits the backups. |
| Schema version | The baseline and inventory files carry `version: 1`. Zod rejects an unknown version. |
| Rollback | `flarewall restore <zone> <backup>` sends a backup back to the zone, with the same dry run, backup, confirmation, and read-back as `apply`. |
| Tests | Vitest. The core takes an injected API client, and tests use a fake client with JSON fixtures on `example.com` hosts. No test calls a live zone. |
| Live checks | Agents build every phase against the fake client. The owner runs each `Done when:` step that calls Cloudflare or GitHub Actions. This box holds no Cloudflare token. |
| Issues | Issue #1 covers Phases 1 to 4. Phases 5, 6, 7, and 8 each get their own issue. Filing them is approved. |
| Second repo | Phase 8 may open a pull request on the repo that holds the old script. The private data repo names that repo. The owner merges it. |
| Skill output | The skill opens a branch and a pull request on the private data repo. A workflow there posts the `flarewall diff` output on the pull request. The skill never holds the write token. |

## Approach

Build the core first, and port the current script's behaviour into it as the first baseline. Add the read-only commands before the write command, so the owner can trust `diff` before `apply` touches a zone. Build the TUI and the skill last, on top of a core that already works from the command line.

This reuses the decisions in the old script's own plan and debug notes, which record why each rule and each exception exists, and the redirect rule cases in its test suite. All three live in the old script's private repo.

Rejected alternatives:

- A pure agent skill with no core. An agent gives a different result each run, which breaks drift detection and leaves no fixed record of what a zone should hold.
- A TUI first. A view with no tested core under it puts the write logic in the UI layer.
- Official tools only. No official tool applies one baseline across many accounts with per-host roles. The Terraform Cloudflare provider is the closest fit, but its open bugs rule it out. See `docs/research/0001-research-flarewall-open-questions-2026-10-21.md`.

### Phase 1: research the API layer and the runtime (#1)

Attended: the owner picks the runtime, the API layer, and the data store from the findings.

Compare the official Cloudflare TypeScript SDK, the `cf` CLI, `wrangler`, and the Terraform provider for each call the baseline needs: list zones, list DNS records, get and update ruleset phases, get and set zone settings, get and set Bot Management, and read Security Events. Record the gaps, the auth model of each, and the release stability. Compare the runtime options and the private data store options.

Done when: a research note in `docs/research/` has one table row per required call with its support in each tool, and the owner has recorded the three picks in this plan's Design decisions.

Status: done on 2026-10-21. The note is `docs/research/0001-research-flarewall-open-questions-2026-10-21.md`, and the picks are in Design decisions.

### Phase 2: baseline format and render (#1)

Define the baseline file format and the zone inventory format, both with `version: 1`. Write the default baseline from the current script's rule set. Write a `render` step that takes a baseline and one zone's inventory entry and produces the exact API payloads. Add `flarewall init`, which copies the default baseline into the data repo. Add the strip CI: the private string check and gitleaks. Change the repo `LICENSE` to MIT and add the `files` allowlist to `package.json`.

Done when: a test renders the payloads for a fixture zone with API hosts and WordPress hosts, and the output matches the JSON that `cf-security-setup.sh` builds for the same input, except for the `flarewall_` refs and the geo country parameter. The strip CI passes on the branch.

### Phase 3: status and diff (#1)

Attended: the owner runs the live checks with a read-only token.

Read the live state of each zone in the inventory and compare it with the rendered baseline, on the allowlist of fields in Design decisions. `status` prints one row per zone with its plan and its state: `in sync`, `drift`, `legacy`, or `not managed`. `diff` prints the changes per zone and exits 0, 1, or 2. Add `flarewall add <zone>`.

Done when: `flarewall status` on a zone that the current script hardened prints `legacy`, and on a zone with a manual rule edit in the dashboard it prints `drift` and `diff` names the changed rule. `flarewall add` writes an inventory file for a zone with no entry. The owner has published `flarewall@0.1.0` to npm.

### Phase 4: apply (#1)

Attended: the owner runs every `--write` step. No agent runs one.

Send the rendered baseline to a zone, with dry run as the default, backup before write, confirmation per zone, and read-back after write. A failure in one zone does not stop the other zones. `apply` keeps unowned rules, replaces legacy rules and keeps their `id`, and checks the Free-plan rule limits against the total of owned and unowned rules before a write. Add `flarewall restore`, with the same safety steps.

Done when: `apply` on a test zone in dry run mode changes nothing, `apply --write` on a script-hardened test zone brings it to the baseline with no duplicate rules, and `status` then prints `in sync`. `restore --write` of the backup from that run brings the zone back to its earlier state.

### Phase 5: scheduled drift alert (#2)

Attended: the owner creates the private data repo and a read-only API token, and runs the live check.

Run `diff` on a schedule in GitHub Actions with the read-only token and an exact `flarewall` version. Open or update one GitHub issue per drifted zone, and close it when the zone is in sync. On a failed run, open one `drift-run-failed` issue.

Done when: a manual dashboard edit on a test zone produces an alert within one scheduled run, a run with no drift sends nothing, and a run with a revoked token opens a `drift-run-failed` issue.

### Phase 6: TUI (#3)

Attended: the owner approves a screen sketch before the build.

Build a TUI over `status`, `diff`, and `apply`. It shows all zones, their drift state, and the diff for the selected zone, and it starts `apply` with the same safety steps as the CLI.

Done when: the TUI lists every inventory zone with the same drift state that `flarewall status` prints, and an apply from the TUI writes the same backup as the CLI.

### Phase 7: flarewall skill (#4)

Attended: the owner runs the live check against a zone's Security Events.

Write the agent skill. It reads Security Events for a zone, finds traffic that passes the baseline or real visitors that the baseline challenges, and proposes an edit to the baseline file or the zone's host roles. It edits `<data>/baseline.yaml` or the zone's inventory file, opens a pull request on the private data repo, runs `diff` to show the effect, and stops before `apply`.

Done when: on a zone with logged probe traffic that passes the baseline, the skill proposes a baseline edit, and `flarewall diff` shows the new rule for that zone with no change sent.

### Phase 8: retire the bash script (#5)

Open a pull request on the old script's repo that points it at flarewall and removes `scripts/cf-security-setup.sh` and its wiki page there, or marks them as superseded. The owner merges it.

Done when: the old script's repo README names flarewall as the tool for Cloudflare hardening, and no doc there tells the reader to run the old script.

## Migration and rollback

The tool writes to live Cloudflare zones. Each `apply` writes a backup of both ruleset phases and the zone settings before it sends a change, as the current script does. Rollback is `flarewall restore` with that backup. Backups are JSON files under `backups/<zone>/<UTC time>/` in the private data repo, and the owner commits them.

A zone that the current script hardened holds rules with no `flarewall_` ref. flarewall recognises them as legacy rules, and the first `apply` replaces them in place and keeps their `id`. The old script and flarewall must not both write to one zone after that first `apply`.

## Open questions

The research note settled the earlier questions. These facts still need one test call each:

- The exact token permission for a zone-level phase entry point GET. One call with a read-only token against one zone settles it. Phase 3 needs it.
- The real Free-plan Security Events limits and the current GraphQL dataset name. One GraphQL `settings` query against one Free zone settles both. Phase 7 needs them.
- Whether GitHub disables a scheduled workflow in a private repo after 60 days with no activity. The docs state the rule for public repos only. The first 60 days of the drift workflow settle it.

## Non-goals

- Team features: shared logins, roles, and review between developers.
- A client-facing view or report.
- Code security audits of Workers or sites. `cloudflare/security-audit-skill` covers that.
- Cloudflare features outside zone security: DNS management, caching rules, Workers deploys.
- Account creation, zone onboarding, or billing changes.
