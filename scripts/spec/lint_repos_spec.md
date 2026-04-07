# Spec: lint_repos Reimplementation

## Motivation

This spec defines a JavaScript tool to lint GitHub repositories for mandatory configuration standards.

## Scope

Many repository settings (branch protections, merge strategies, visibility, etc.) are enforced at the organization level and cannot be changed by repository owners. This linter checks **only the settings that repository owners can modify themselves**:

- **Repository description** — must be set to a non-empty string
- **Repository topics** — between 1 and 5 topics, all chosen from an approved taxonomy. The taxonomy exists to prevent synonym drift (e.g. `ai` vs `ml`, `k8s` vs `kubernetes`) so topics can be used reliably for repository filtering and organisation-wide statistics.
- **Required files** — README, CONTRIBUTING, and LICENSE must be present in the repository
- **License type** — must be from an approved list of SPDX identifiers

All rules are configurable via a YAML configuration file — see [Configuration File](#configuration-file).

---

## Implementation Approach

A single JavaScript file `scripts/lint_repos.js`, run with `node`. Dependencies managed via `scripts/package.json` (shared across all JS scripts added to this repo in the future).

### npm packages

| Package | Purpose |
|---|---|
| `@octokit/rest` | GitHub REST API (repos, issues, license detection via `spdx_id`). Auth via `GITHUB_TOKEN` environment variable. Eliminates the `licensee` Ruby gem dependency. |
| `simple-git` | Async wrapper around the `git` CLI. Repos are cloned in parallel batches of 5, then file checks run on the completed clones. |
| `js-yaml` | Parse YAML config files |

### Project structure

```
scripts/
  package.json          # shared for all JS scripts in this repo
  package-lock.json
  node_modules/
  lint_repos.js
```

### Local usage

```bash
export GITHUB_TOKEN=$(gh auth token)   # or set a PAT directly
cd scripts
npm install
node lint_repos.js --org <org> [--config <file>] [--dry-run] [--debug]
```

The script requires `GITHUB_TOKEN` to be set in the environment. No other external tool dependencies beyond `git`.

`lint_cache/` and the default config path are resolved relative to the script file's location (repo root), not the working directory — so the script behaves correctly regardless of where it is invoked from.

---

## CLI Interface

```
node scripts/lint_repos.js --org <org> [--config <file>] [--dry-run] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to lint |
| `--config` | `config/lint_repos.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Run checks but do not create/close issues |
| `--debug` | false | Print verbose output |

---

## Configuration File

Configuration lives at `config/lint_repos.yaml`.

```yaml
# Title of the GitHub issue created in non-compliant repos.
# Also used as the lookup key when searching for an existing open issue —
# changing this will cause the script to stop recognising previously opened issues.
issue_title: "Mandatory Repository Configuration"

# URL inserted into the issue body as the "standards guide" link.
docs_link: "https://..."

# Repos to skip entirely — no checks run, no issues created or closed.
# They appear in output under "Skipped (configuration)".
excluded_repos: []

# SPDX identifiers accepted by the license check. Compared against
# repo.license.spdx_id from the GitHub API. null and NOASSERTION are
# always rejected regardless of this list.
allowed_licenses:
  - Apache-2.0
  - MIT
  - CC-BY-4.0
  - CC0-1.0

# File checks run against the local clone. Each entry must match at least one
# file in the specified search_paths. pattern is a case-insensitive prefix glob
# (e.g. README* matches README.md). description is used as the check name in
# issue body and output. search_paths defaults to ["."] if omitted.
required_files:
  - pattern: "README*"
    description: "Readme File"
  - pattern: "CONTRIBUTING*"
    search_paths: [".", ".github", "docs"]
    description: "Contributing File"
  - pattern: "LICENSE*"
    description: "License File"

# Controlled topic vocabulary. Every active repo must have 1–5 topics,
# all from this list. An empty list disables the allowlist check (any topic accepted).
allowed_topics:
  - cli
  - docs
  - ...
```

---

## Checks

| # | Check | Data source | Pass condition |
|---|---|---|---|
| 1 | **Description** | GitHub API | `description` is non-null and non-empty |
| 2 | **Topics** | GitHub API | Between 1 and 5 topics assigned; all topics must be in `allowed_topics` |
| 3 | **License type** | GitHub API | `license.spdx_id` is in `allowed_licenses`; fails with a clear message if API returns null (no license detected) or `NOASSERTION` (custom license text GitHub could not identify) |
| 4 | **Required files** | Local clone | Each `required_files` entry matches at least one file in the specified `search_paths` (includes LICENSE*) |

Checks 1, 2, and 3 use only API data (no clone needed). Check 4 requires the local clone.

---

## Execution Flow

```
1. Read GITHUB_TOKEN from environment — exit with clear error if missing
2. Parse CLI arguments
3. Load config with js-yaml
4. Instantiate Octokit with the token
5. Fetch all public repos in org (paginated):
     octokit.paginate(octokit.rest.repos.listForOrg, { org, type: "public" })
   Each repo object includes: name, description, license, topics, archived
   Split into active (archived: false, not excluded), archived (archived: true, not excluded), and excluded (name in `excluded_repos`) lists
6. Run metadata checks (description, topics, license type) for all repos from API data
7. Clone/update active repos in batches of 5 using simple-git:
     - Directory exists: git.fetch() + git.reset(['--hard', 'origin/HEAD'])
     - Directory missing: git.clone(url, lint_cache/<repo>)
   Batches run sequentially; the 5 clones within each batch run in parallel via Promise.all
   Archived repos are not cloned.
8. For each active repo (sequentially after cloning):
   a. Run file-existence checks on local clone
   b. Aggregate metadata + file check results into a failures list
   c. Failures present:
        - If no open issue with matching title exists: create issue (unless --dry-run)
   d. All checks pass:
        - If an open issue with matching title exists: close it with a resolved comment (unless --dry-run)
   e. Print summary line to stdout
9. For each archived repo: run all checks (metadata only, no clone) and print summary line — no issue action taken
10. For each excluded repo: print name only under "Skipped (configuration)" — no checks, no issue action
11. Exit 0 if all active repos pass, exit 1 if any active repo failed (archived/excluded do not affect exit code)
```

---

## Issue Lifecycle

| Repo state | Existing issue? | Action |
|---|---|---|
| Non-compliant | No open issue | Create issue |
| Non-compliant | Open issue exists | Leave open (no duplicate) |
| Compliant | Open issue exists | Close issue with resolved comment |
| Compliant | No open issue | No action |
| Archived (any) | — | No issue action |
| Excluded (any) | — | No checks run, no issue action |

The script only considers **open** issues. If a user manually closes the issue but the repo remains non-compliant, a new issue will be created on the next run.

Archived repos are checked for compliance and shown in a separate output section, but no issues are ever created or closed for them.

Issue lookup uses `octokit.rest.issues.listForRepo` filtered by `state: "open"` and matching `issue_title` from config.

### Issue body template

```markdown
## Mandatory Repository Configuration

The following compliance checks failed for this repository:

| Check | Status | Details |
|-------|--------|---------|
| Repository Description | ❌ Failed | No description set |
| Repository Topics     | ✅ Passed | |
| README File           | ✅ Passed | |
| CONTRIBUTING File     | ❌ Failed | File not found in ., .github, docs |
| License File          | ✅ Passed | |
| License Type          | ❌ Failed | 'WTFPL' is not in the approved list |
| License Type          | ❌ Failed | Custom license text detected — GitHub could not identify a standard SPDX license. Ensure the license is based on an approved one. |

Please review the [Mandatory Repository Configuration](<docs_link>) guide and address the issues above.

_This issue was automatically generated by the OSPO linting bot._
```

---

## Output / Reporting

With `--debug`, cloning progress is printed first, followed by a `Results` header and one line per repo. Failing repos additionally show the reason for each failure indented below:

```
Cloning batch 1/2...
  Cloning my-repo...
  Cloning another-repo...
Cloning batch 2/2...
  Updating third-repo...

Results
───────
✅ my-repo
❌ another-repo  [Description, Contributing File]
     Repository Description: No description set
     Contributing File: File not found in ., .github, docs
✅ third-repo
```

Without `--debug`, only the `Results` header and repo lines are printed. The failing check names are listed in brackets for non-compliant repos. Archived repos appear in a separate section after active repos. No files are written to disk.

Icons: `✅` pass, `❌` fail (active repos); `✔️` pass, `✖️` fail (archived repos — informational only). 

```
Results
───────
✅ my-repo
❌ another-repo  [Description, Contributing File]
✅ third-repo

Skipped (archived)
──────────────────
✔️ old-repo
✖️ archived-repo  [Contributing File]

Skipped (configuration)
───────────────────────
– excluded-repo
```

When `--dry-run` is active and there are pending actions, a summary block is appended after the archived section:

```
──── Dry-run: 2 issues would be created, 1 would be closed ────
  ✉️   create  another-repo
  ✉️   create  fourth-repo
  ✔️   close  #42  third-repo
```

---

## Dependencies

| Tool | Purpose | Change vs. today |
|---|---|---|
| `node` + `npm` | Run the script, install packages | Node was already needed; npm replaces `npm install -g repolinter` |
| `@octokit/rest` | GitHub API + issue management | Replaces `gh api` calls |
| `js-yaml` | Parse YAML config | Replaces `yq` for config parsing |
| `simple-git` | Async clone and update repos | Replaces `child_process.execSync` git calls |
| `git` | Required by simple-git at runtime | Was already implicitly required |

**Removed dependencies:**
- `gh` CLI (no longer required by this script)
- `repolinter` (archived npm global)
- `licensee` Ruby gem + Ruby runtime

---

## Unit Tests

Unit tests live in `scripts/lint_repos.test.js` (next to the source file) and run with Node's built-in test runner (`node --test`). No additional test framework required.

Each check function is tested in isolation with fake API responses and a temporary directory for file-system checks. Key scenarios per check:

- **Description:** set, empty string, null
- **Topics:** none assigned; topic not in `allowed_topics`; `allowed_topics` empty (any accepted)
- **License type:** allowed, disallowed, API returns null, API returns `NOASSERTION` (custom license text)
- **Required files:** all present; each file missing individually; match in `search_paths` subdirectory; case-insensitive match
- **Config loading:** valid config; missing required field `issue_title`; `allowed_topics` absent (defaults to empty); `excluded_repos` absent (defaults to empty); `excluded_repos` list preserved

### Integration test (against `ospo-sandbox`)

Requires `GITHUB_TOKEN`. Run via Makefile, not part of the unit test suite.

```makefile
test_lint_repos:
    cd .. && node scripts/lint_repos.js --org ospo-sandbox --config scripts/test-config/lint_repos.yaml --debug
```

---

## CI/CD Changes

`.github/workflows/lint_repos.yml` setup:

- Node.js setup step
- `npm ci` run from the `scripts/` directory
- `actions/cache` restores/saves `lint_cache/` under key `lint-cache-allianz` — repos are cloned once and updated in place on subsequent runs
- Run step: `node scripts/lint_repos.js --org allianz`
- Pass the GitHub App token as `GITHUB_TOKEN` env var to the run step
