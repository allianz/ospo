# Spec: archive_repos implementation

## Motivation

Repositories that go dormant create maintenance overhead, security risk, and confusion for external contributors. Rather than requiring OSPO administrators to manually identify and archive stale projects, this script automates the full lifecycle: detection, warning, grace period enforcement, and archival. The two-stage warning mechanism gives maintainers a chance to signal that a project is still relevant before it is archived.

## Scope

The script manages:

- **Stale repository detection** — identifies repos with no push activity within a configurable period
- **Warning issue lifecycle** — creates, monitors, and closes "Inactive Repository Reminder" issues
- **Grace period enforcement** — archives repos only after the warning issue has been open long enough
- **Automatic recovery** — closes warning issues when a repo becomes active again

Out of scope:

- Repository creation and team management (handled by `create_repos`)
- Repository compliance linting (handled by `lint_repos`)
- Unarchiving repositories (manual process via OSPO team at ospo@allianz.com)

---

## Implementation Approach

A single JavaScript file `scripts/archive_repos.js`, run with `node`. Dependencies managed via `scripts/package.json` (shared across all JS scripts in this repo).

### npm packages

| Package | Purpose |
|---|---|
| `@octokit/rest` | GitHub REST API (repos, issues, archiving). Auth via `GITHUB_TOKEN` or `GH_TOKEN` environment variable. |
| `js-yaml` | Parse YAML config files |

No additional packages required beyond what is already in `scripts/package.json`. The `simple-git` dependency (used by `lint_repos.js`) is not needed here — the script works entirely through the GitHub API.

### Project structure

```
scripts/
  package.json          # shared for all JS scripts in this repo
  package-lock.json
  node_modules/
  archive_repos.js
  archive_repos.test.js
  spec/
    archive_repos_spec.md
```

### Local usage

```bash
export GITHUB_TOKEN=$(gh auth token)   # or set a PAT directly
cd scripts
npm install
node archive_repos.js --org <org> [--config <file>] [--dry-run] [--debug]
```

The script requires `GITHUB_TOKEN` (or `GH_TOKEN`) to be set in the environment. The default config path is resolved relative to the script file's location (repo root), not the working directory.

---

## CLI Interface

```
node scripts/archive_repos.js --org <org> [--config <file>] [--dry-run] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to scan for stale repos |
| `--config` | `config/archive_repos.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Simulate execution without creating issues, closing issues, or archiving repos |
| `--debug` | false | Print verbose output (computed dates, per-repo decisions) |

Exit codes: `0` on success, `1` on missing `--org`, missing token, or fatal error.

---

## Configuration File

Configuration lives at `config/archive_repos.yaml`.

```yaml
# Repos to skip entirely — never checked for staleness, never archived.
excluded_repos:
  - .github
  - ospo

# How long without a push before a warning issue is created.
# Format: "<N> <unit>" where unit is day(s), month(s), or year(s).
warn_after: "2 years"

# How long the warning stays open before the repo is archived.
# Format: "<N> <unit>" where unit is day(s), month(s), or year(s).
grace_period: "40 days"
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `excluded_repos` | Array of strings | `[]` | Repository names to skip. These repos are never checked and never appear in output. |
| `warn_after` | String | required | Duration string. Repos with no push activity for this long get a warning issue. |
| `grace_period` | String | required | Duration string. Warning issues open for this long trigger archival. |

### Validation

- `warn_after` must be present and must match the pattern `"<N> <unit>"`.
- `grace_period` must be present and must match the pattern `"<N> <unit>"`.
- `excluded_repos` defaults to `[]` if absent.
- Unknown fields are ignored (forward-compatible).

---

## Date Parsing

Duration strings like `"2 years"` or `"40 days"` are parsed by `parseRelativeDate(str)`:

1. Validate against regex: `/^(\d+)\s+(days?|months?|years?)(\s+ago)?$/`
2. Throw descriptive error if the string does not match.
3. Start from `new Date()` (current time).
4. Subtract using UTC methods:
   - `day`/`days` → `date.setUTCDate(date.getUTCDate() - n)`
   - `month`/`months` → `date.setUTCMonth(date.getUTCMonth() - n)`
   - `year`/`years` → `date.setUTCFullYear(date.getUTCFullYear() - n)`
5. Return the `Date` object.

This function is exported for unit testing.

---

## Execution Flow

```
1. Read GITHUB_TOKEN (or GH_TOKEN) from environment — exit with clear error if missing
2. Parse CLI arguments (--org, --config, --dry-run, --debug)
3. Load and validate YAML config with js-yaml
4. Convert warn_after and grace_period to Date objects via parseRelativeDate()
5. Instantiate Octokit with the token
6. Fetch all repos in org (paginated):
     octokit.paginate(octokit.rest.repos.listForOrg, { org, per_page: 100 })
   Filter client-side: remove archived, separate excluded from candidates, sort by name
7. For each candidate repo (sequentially):
   a. Compare repo.pushed_at against staleCutoff
   b. If stale:
      - Find open issue titled "Inactive Repository Reminder"
      - If no issue: create it (or record planned action in dry-run)
        Set effectiveIssueDate = now (issue was just created / would be created)
      - If issue exists: set effectiveIssueDate = issue.created_at
      - If effectiveIssueDate < graceCutoff: archive the repo (or record)
      - Else: log grace period remaining
   c. If NOT stale:
      - If open warning issue exists: close it (or record planned close)
8. Print dry-run summary if applicable
```

### effectiveIssueDate in dry-run mode

When `--dry-run` is active and no warning issue exists, the issue is not actually created. To keep grace-period logic correct, the code uses `new Date()` (current time) as the effective issue creation date. Since "just now" is always more recent than `graceCutoff`, the repo is correctly **not** scheduled for archival in the same dry-run pass. This prevents the dry-run output from reporting both "would create issue" and "would archive" for the same repo in a single run.

---

## Issue Lifecycle

| Repo state | Existing issue? | Action |
|---|---|---|
| Stale | No open issue | Create warning issue |
| Stale | Open issue, grace period NOT expired | Log remaining grace period |
| Stale | Open issue, grace period expired | Archive the repository |
| Not stale | Open issue exists | Close the issue (repo became active again) |
| Not stale | No open issue | No action |
| Excluded | — | Skip entirely |

The script only considers **open** issues. If a user manually closes the warning issue but the repo remains stale, a new issue will be created on the next run.

Issue lookup uses `octokit.rest.issues.listForRepo` filtered by `state: "open"` and matching the constant issue title.

### Warning issue template

**Title:** `Inactive Repository Reminder` (hardcoded constant, also used as the lookup key)

**Body:** generated by `buildIssueBody(gracePeriod)`, which interpolates the `grace_period` config value into the template:

```markdown
Dear Maintainers,

This repository has had no activity for an extended period. Inactive repositories tend to accumulate outdated dependencies and security vulnerabilities over time. To prevent this, this repository will be archived if no action is taken within the next ${grace_period}.

**What you can do:**
- Review and update dependencies
- Address any open Dependabot or security alerts
- If the project is stable and needs no changes, push an empty commit to confirm continued ownership:

      git commit --allow-empty -m "Keep repository active"

**Request for Unarchival:**
In case the repository is archived and there's a legitimate reason to revive it, please contact ospo@allianz.com with your request for unarchiving.

Best regards,

OSPO Team
```

### Closing issues

When a repo becomes active again, the warning issue is closed silently via `octokit.rest.issues.update({ state: 'closed' })` — no closing comment is added.

### Archiving repositories

Archiving uses `octokit.rest.repos.update({ archived: true })`. Once archived, only org admins can unarchive.

---

## Module Structure

```
scripts/archive_repos.js

  #!/usr/bin/env node

  // ── Imports ──────────────────────────────────────────────────────────────────
  import { Octokit } from '@octokit/rest';
  import yaml from 'js-yaml';
  import { readFile } from 'node:fs/promises';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  // ── Constants ────────────────────────────────────────────────────────────────
  const __dirname, repoRoot, defaultConfigPath
  const ISSUE_TITLE, ISSUE_BODY

  // ── Date parsing ─────────────────────────────────────────────────────────────
  export function parseRelativeDate(str) { ... }

  // ── Config ───────────────────────────────────────────────────────────────────
  export async function loadConfig(configPath) { ... }

  // ── Issue helpers (internal) ─────────────────────────────────────────────────
  async function findOpenIssue(octokit, org, repo, issueTitle) { ... }
  async function createIssue(octokit, org, repo, title, body) { ... }
  async function closeIssue(octokit, org, repo, issueNumber) { ... }

  // ── Core logic ───────────────────────────────────────────────────────────────
  export async function processRepos(octokit, org, repos, config, opts) { ... }

  // ── Main ─────────────────────────────────────────────────────────────────────
  async function main() { ... }

  // ── Entry point guard ────────────────────────────────────────────────────────
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(err => { ... process.exit(1) });
  }
```

### Exports (for testability)

| Export | Purpose |
|---|---|
| `parseRelativeDate` | Pure function, core to correctness, easy to unit test |
| `loadConfig` | Validates config structure, unit tested with temp YAML files |
| `processRepos` | Main processing loop, tested with mock Octokit and deterministic dates |

Issue helpers (`findOpenIssue`, `createIssue`, `closeIssue`) remain internal — they are exercised implicitly through `processRepos` tests.

### Key design decisions

**`findOpenIssue` returns the full issue object** (not just the number like in `lint_repos.js`), because the caller needs both `issue.number` (for closing) and `issue.created_at` (for grace period calculation). Returns `null` if no match found.

**`processRepos` takes pre-computed Date cutoffs** rather than raw config strings:
```js
export async function processRepos(octokit, org, repos, config, opts = {})
// config: { staleCutoff: Date, graceCutoff: Date }
// opts:   { dryRun: boolean, debug: boolean }
// Returns: { planned: string[] }
```
This makes testing with deterministic dates straightforward — callers pass fixed Date objects instead of relative strings.

---

## Output / Reporting

### Normal mode

```
READING REPOSITORIES...

my-stale-repo is stale.
  Created warning issue.

another-stale-repo is stale.
  another-stale-repo has remaining grace period.

old-repo is stale.
  Archived the repository 'test-org/old-repo'.

active-repo
  Closed the existing issue in the repository 'test-org/active-repo'.

healthy-repo
```

### Debug mode

Adds computed dates at startup and per-repo details (pushed_at timestamps, issue creation dates, cutoff comparisons):

```
Stale period cutoff: 2024-04-11T00:00:00.000Z
Grace period cutoff: 2026-03-02T00:00:00.000Z
Repos to process: my-stale-repo, another-stale-repo, old-repo, active-repo, healthy-repo
Excluded repos: .github, ospo

READING REPOSITORIES...

my-stale-repo is stale.
  pushed_at: 2023-01-15T00:00:00Z (before 2024-04-11T00:00:00.000Z)
  No warning issue found.
  Created warning issue.
  ...
```

### Dry-run mode

Changes are collected but not executed. A summary block is appended at the end:

```
READING REPOSITORIES...

my-stale-repo is stale.
old-repo is stale.
active-repo

Planned changes:
  Would create an issue for 'test-org/my-stale-repo'.
  Would archive repository 'test-org/old-repo'.
  Would close the existing issue in 'test-org/active-repo'.
```

---

## Dependencies

| Tool | Purpose |
|---|---|
| `node` + `npm` | Run the script, install packages |
| `@octokit/rest` | GitHub API (repos, issues, archiving) |
| `js-yaml` | Parse YAML config |

No `git`, `gh`, `yq`, `jq`, or system `date` command required.

---

## Unit Tests

Unit tests live in `scripts/archive_repos.test.js` and run with Node's built-in test runner (`node --test`). No additional test framework required.

Each function is tested in isolation using a `makeOctokit(overrides)` helper for mock API methods and `makeRepo(name, pushedAt)` for repo fixtures. Key scenarios:

- **`parseRelativeDate`:** years, months, days (singular and plural); `"ago"` suffix accepted; invalid formats throw
- **`loadConfig`:** valid config; `excluded_repos` defaults to `[]`; missing or invalid `warn_after`/`grace_period` throw
- **`processRepos`:** stale with no issue (create, no archive); stale with issue in grace period (no action); stale with expired issue (archive); active with open issue (close); dry-run produces no mutations; dry-run newly created issue does not trigger archival

### Integration test (against `ospo-sandbox`)

Requires `GITHUB_TOKEN`. Run via Makefile, not part of the unit test suite:

```makefile
test_archive_repos: check-token
    node archive_repos.js --org ospo-sandbox --config test-config/archive_repos.yaml --debug
```

---

## CI/CD

`.github/workflows/archive_repos.yml` setup:

- **Schedule:** Weekly on Sunday at midnight UTC (`0 0 * * 0`)
- **Manual trigger:** `workflow_dispatch`
- Node.js 22 setup step
- `npm ci` run from the `scripts/` directory
- GitHub App token generated via `actions/create-github-app-token`
- Run step: `node scripts/archive_repos.js --org allianz`
- Pass the GitHub App token as `GITHUB_TOKEN` env var to the run step

