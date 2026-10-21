# QA Plan: flarewall core and CLI (issue #1, Phases 2 to 4)

_Generated 2026-10-21 · against `66322d1` (clean, with this QA plan uncommitted) · covers `init`, `add`, `status`, `diff`, `apply`, `restore`, the strip CI, and the package contents_

## Summary
- flarewall renders one baseline per zone, reports drift, and applies or restores the baseline on live Cloudflare zones.
- "Working" means the live checks below give the same states that the tests give against the fake client.

## Environment
True for the whole plan. Do this once, before Scenario 1.

- Use the branch `issue-1-build-the-flarewall-baseline-tool-for-cloudflare` on your own machine, not on the dev box.
- Create a private data folder outside every repo, for example `~/flarewall-data`. It holds no file yet.
- Keep two user tokens ready. The read-only token has Zone Read, Zone Settings Read, Zone WAF Read, Bot Management Read, and a rulesets read permission. The write token adds the matching edit permissions.
- Pick two zones. The *hardened zone* is a zone that the old script hardened. The *test zone* is a zone with no real visitors, which you can change freely.

Build and set the data path with:

```sh
pnpm install && pnpm build
```

```sh
export FLAREWALL_DATA=~/flarewall-data
```

```sh
alias flarewall="node $PWD/dist/cli/main.js"
```

- [ ] Environment ready

## Test cases at a glance

Priority legend: 🔴 Critical · 🟡 Normal · 🟢 Low

| # | Scenario | Test case | Priority |
|------|----------|-----------|----------|
| TC-1.1 | 1: Read-only token, empty data folder | Onboard the hardened zone and see `legacy` | 🔴 Critical |
| TC-1.2 | 1: Read-only token, empty data folder | See `drift` after a dashboard edit | 🔴 Critical |
| TC-1.3 | 1: Read-only token, empty data folder | Read the `status` table for all zones | 🟡 Normal |
| TC-2.1 | 2: Write token, test zone hardened by the old script | Dry run sends nothing | 🔴 Critical |
| TC-2.2 | 2: Write token, test zone hardened by the old script | Apply brings the zone to `in sync` | 🔴 Critical |
| TC-2.3 | 2: Write token, test zone hardened by the old script | Restore returns the zone to its earlier state | 🔴 Critical |
| TC-3.1 | 3: Branch merged, strip CI green | Publish `flarewall@0.1.0` | 🟡 Normal |

## Scenario 1: Read-only token, empty data folder

**Setup.** Run once, for every case in this scenario.

1. Set the read-only token in this shell only.

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
```

2. Copy the default baseline into the data folder.

```sh
flarewall init
```

- [ ] Setup complete

### TC-1.1: Onboard the hardened zone and see `legacy`  ·  🔴 Critical

**Goal.** A zone that the old script hardened shows `legacy`, not `drift` and not `in sync`.

**Steps**

1. Write the inventory file for the hardened zone. Replace `hardened.example` with the zone name.

   ```sh
   flarewall add hardened.example
   ```

   - [ ] The command prints the path of a new file under `inventory/`, and the file lists the zone's proxied hostnames as comments
2. Edit that file. Put the API hosts under `hosts.api` and the WordPress hosts under `hosts.wordpress`. Set `geo` and `redirects` to the answers you gave the old script for this zone.
3. Run `diff` on the zone.

   ```sh
   flarewall diff hardened.example; echo "exit $?"
   ```

   - [ ] The zone shows `legacy`, and the exit code is 1
     - the legacy rules listed are the old script's rules: ports, scanner probes, hosting networks, the geo rule when it is on, the rate limit, and the redirects
     - no rule shows as changed only because of a field you never set, such as an extra field inside `action_parameters`
   - [ ] Each hand-made rule in the dashboard shows as `unowned`, not as drift

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _If a phase GET fails with a permission error, write the permission that fixed it here. That settles the plan's open question for Phase 3._

### TC-1.2: See `drift` after a dashboard edit  ·  🔴 Critical

**Goal.** A manual change to a flarewall rule shows as drift and names the rule.

**Steps**

1. Do this case after TC-2.2, on the test zone, because a zone in `legacy` state shows `legacy` first. In the dashboard, change the expression of the flarewall rule "flarewall: block non-standard ports" on the test zone. Save it.
2. Run `diff` on the test zone with the read-only token.

   ```sh
   flarewall diff test.example; echo "exit $?"
   ```

   - [ ] The zone shows `drift`, the output names `flarewall_ports`, and the exit code is 1
3. Undo the dashboard edit, and run the same command again.
   - [ ] The zone shows `in sync`, and the exit code is 0

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** __

### TC-1.3: Read the `status` table for all zones  ·  🟡 Normal

**Goal.** `status` shows every zone that the token can see on one screen.

**Steps**

1. Run `status` with no zone names.

   ```sh
   flarewall status; echo "exit $?"
   ```

   - [ ] The table is easy to read, and each zone has its plan and one state
     - zones with an inventory file show `in sync`, `drift`, or `legacy`
     - zones with no inventory file show `not managed`
   - [ ] The run of 10 to 50 zones finishes in an acceptable time, with no HTTP 429 error

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** __

**Reset.** Run after every case above, before you move to Scenario 2.

```sh
unset CLOUDFLARE_API_TOKEN
```

## Scenario 2: Write token, test zone hardened by the old script

**Setup.** Run once, for every case in this scenario.

1. Run the old script on the test zone with `--apply`, so the zone starts in the state of a hardened zone. Use the same answers that you write into the inventory in step 3.
2. Set the write token in this shell only.

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
```

3. Write and edit the inventory file for the test zone, as in TC-1.1.

```sh
flarewall add test.example
```

- [ ] Setup complete

### TC-2.1: Dry run sends nothing  ·  🔴 Critical

**Goal.** `apply` without `--write` prints the plan and changes nothing on the zone.

**Steps**

1. Run `apply` without `--write`.

   ```sh
   flarewall apply test.example; echo "exit $?"
   ```

   - [ ] The output shows the rules it would send, with the legacy rules replaced and no rule listed twice
   - [ ] The Security rules in the dashboard and the zone's Audit Log show no change

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** __

### TC-2.2: Apply brings the zone to `in sync`  ·  🔴 Critical

**Goal.** One `apply --write` replaces the old script's rules in place and leaves the zone in sync.

**Steps**

1. Run `apply` with `--write`, and answer `y` at the prompt.

   ```sh
   flarewall apply test.example --write; echo "exit $?"
   ```

   - [ ] The command prints a backup path under `backups/test.example/`, reports a clean read-back, and exits 0
2. Open the zone's custom rules in the dashboard.
   - [ ] The zone holds the flarewall rules once each, the hand-made rules after them, and no old script rule
3. Run `status` on the zone.

   ```sh
   flarewall status test.example; echo "exit $?"
   ```

   - [ ] The zone shows `in sync`, and the exit code is 0

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** _Write the backup path here. TC-2.3 needs it._

### TC-2.3: Restore returns the zone to its earlier state  ·  🔴 Critical

**Goal.** `restore --write` with the TC-2.2 backup puts the old script's rules back.

**Steps**

1. Run `restore` with the backup path from TC-2.2, and answer `y` at the prompt.

   ```sh
   flarewall restore test.example "$FLAREWALL_DATA/backups/test.example/<time from TC-2.2>" --write; echo "exit $?"
   ```

   - [ ] The command prints a new backup path, reports a clean read-back, and exits 0
2. Run `status` on the zone.

   ```sh
   flarewall status test.example; echo "exit $?"
   ```

   - [ ] The zone shows `legacy` again, and the dashboard shows the old script's rules

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** __

**Reset.** Run after every case above.

```sh
flarewall apply test.example --write
```

```sh
unset CLOUDFLARE_API_TOKEN
```

## Scenario 3: Branch merged, strip CI green

**Setup.** Run once, for every case in this scenario.

1. Add the `FLAREWALL_PRIVATE_STRINGS` repository secret, with one private string on each line.
2. Merge the pull request, and check out `main`.

- [ ] Setup complete

### TC-3.1: Publish `flarewall@0.1.0`  ·  🟡 Normal

**Goal.** The public package holds only the built code and no private data.

**Steps**

1. Confirm that the last CI run on `main` passed all three jobs: build, private strings, and gitleaks.
   - [ ] All three jobs are green
2. Read the package contents.

   ```sh
   npm pack --dry-run
   ```

   - [ ] The list holds only `dist/`, `LICENSE`, `README.md`, and `package.json`
3. Publish the package.

   ```sh
   npm publish
   ```

   - [ ] The npm page for `flarewall` shows version 0.1.0 and the MIT license

**Result**

- [ ] Pass
- [ ] Fail
- [ ] Skipped

**Notes.** __

## Automated verification (by AI agent)
_Checks the agent ran itself. No action needed from the tester; listed here for context and sign-off._

Commands run, at `66322d1`:

```sh
pnpm test
```

```sh
pnpm typecheck
```

```sh
pnpm build
```

```sh
FLAREWALL_PRIVATE_STRINGS="$(cat ~/flarewall-private-strings.txt)" pnpm check:private
```

```sh
FLAREWALL_PRIVATE_STRINGS= pnpm check:private
```

```sh
npm pack --dry-run
```

```sh
D=$(mktemp -d) && node dist/cli/main.js init --data "$D" && node dist/cli/main.js init --data "$D"
```

```sh
node dist/cli/main.js status --data "$(mktemp -d)"
```

```sh
CLOUDFLARE_API_TOKEN=x node dist/cli/main.js apply --data "$(mktemp -d)"
```

```sh
CLOUDFLARE_API_TOKEN=x node dist/cli/main.js apply example.com --write --data "$(mktemp -d)" </dev/null
```

```sh
docker run --rm -v "$PWD":/repo zricethezav/gitleaks:latest git /repo --log-opts="--all" --redact
```

- ✅ `pnpm test` → 79 tests pass in 9 files. The tests cover C1 to C15 against the in-memory fake client: render matches the old script's JSON, `legacy`/`drift`/`in sync`/`unowned`/`not managed`/`error` states, `diff` exit codes, `add`, dry run with zero writes, apply with backup and read-back and kept ids, the Free plan limit skip, per-zone failure isolation, and restore.
- ✅ `pnpm typecheck` → exit 0, against the real `cloudflare` 7.3.0 types.
- ✅ `pnpm build` → exit 0.
- ✅ private string check with the agent's list of 4 private strings → no match in 51 tracked and untracked files, this QA plan included, exit 0.
- ✅ private string check with an empty secret → exit 2, so a missing secret fails the CI job.
- ✅ `npm pack --dry-run` → ships only `dist/**` (with `dist/baseline/default.yaml`), `LICENSE`, `README.md`, and `package.json`.
- ✅ `LICENSE` → MIT. `package.json` → license MIT, `cloudflare` pinned to `7.3.0`, files `["dist"]`.
- ✅ `init` → writes `baseline.yaml`, exit 0. A second `init` → exit 2, and the file is unchanged.
- ✅ `status` with no token → "CLOUDFLARE_API_TOKEN is not set; flarewall reads the Cloudflare token from this variable only", exit 2.
- ✅ `apply` with no zone → "apply needs zone names or --all", exit 2.
- ✅ `apply --write` with no TTY and no `--yes` → "refusing to write: stdin is not a terminal ...", exit 2.
- ✅ gitleaks over all 25 commits of every branch → "no leaks found".

## Not covered / needs human judgment
- Live Cloudflare behavior: the read shape of `action_parameters`, the response of a phase update, Cloudflare's reaction to a restore that sends the ids of deleted rules, and the token permission for a zone phase GET. Scenarios 1 and 2 cover these.
- `src/node/sdk-client.ts` has no test, because only a live zone can exercise it. Scenarios 1 and 2 cover it.
- Concurrency: flarewall runs one zone at a time, and no two runs share a zone. This plan does not test two runs at once.
- UI, accessibility, and browser compatibility: the change has no UI.
- The private strings still exist in older commits of the history. A history rewrite removes them. That step is outside this branch.

## Overall result
_Tick one when you finish the run, or skip the ticks. Report each failure in the agent session or as a PR comment, and the agent records it here._

- [ ] Pass: every case passed
- [ ] Fail: at least one case failed
- [ ] Partial: cases were skipped or not reached
