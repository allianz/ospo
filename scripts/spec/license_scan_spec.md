# Spec: license_scan

## Motivation

This spec defines a JavaScript tool to scan GitHub repositories for dependencies whose licenses are on a deny-list. Unlike `lint_repos`, which checks the repository's own license, this tool inspects **transitive dependencies** using the GitHub Dependency Graph — surfacing copyleft or otherwise prohibited licenses introduced by third-party packages before they cause legal issues.

## Scope

The scanner checks every active repository in the organization. For each repo it:

- Fetches the dependency graph SBOM via the GitHub API
- Compares each dependency's SPDX license identifier against a configurable deny-list
- Creates or updates a GitHub issue in the affected repository listing all offending packages
- Closes the issue automatically when all violations are resolved

All rules are configurable via a YAML configuration file — see [Configuration File](#configuration-file).

---

## Implementation Approach

A single JavaScript file `scripts/license_scan.js`, run with `node`. Shares `scripts/package.json` with the other scripts.

### npm packages

| Package | Purpose |
|---|---|
| `@octokit/rest` | GitHub REST API (dependency graph SBOM, issue management). Auth via `GITHUB_TOKEN` environment variable. |
| `js-yaml` | Parse YAML config files |

No `simple-git` dependency — the dependency graph is fetched entirely via the API; no local cloning is needed.

### Project structure

```
scripts/
  package.json          # shared for all JS scripts in this repo
  package-lock.json
  node_modules/
  license_scan.js
  license_scan.test.js
```

### Local usage

```bash
export GITHUB_TOKEN=$(gh auth token)   # or set a PAT directly
cd scripts
npm install
node license_scan.js --org <org> [--config <file>] [--dry-run] [--debug]
```

The script requires `GITHUB_TOKEN` (or `GH_TOKEN`) to be set in the environment. Default config path is resolved relative to the script file's location (repo root), not the working directory.

---

## CLI Interface

```
node scripts/license_scan.js --org <org> [--config <file>] [--dry-run] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to scan |
| `--config` | `config/license_scan.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Run checks but do not create/close issues |
| `--debug` | false | Print extra per-repo stats (e.g. count of packages with no license info) |

---

## Configuration File

Configuration lives at `config/license_scan.yaml`. The existing `deny-licenses` list is extended with additional fields:

```yaml
# Title of the GitHub issue created in non-compliant repos.
# Also used as the lookup key when searching for an existing open issue —
# changing this will cause the script to stop recognising previously opened issues.
issue_title: "Dependency License Violation"

# URL inserted into the issue body as the license policy link.
docs_link: "https://..."

# Repos to skip entirely — no checks run, no issues created or closed.
# They appear in output under "Skipped (configuration)".
excluded_repos: []

# SPDX identifiers that are not permitted in dependencies.
# Packages whose spdxId is NOASSERTION, NONE, or null are silently ignored.
deny-licenses:
  - GPL-2.0
  - GPL-2.0-only
```

Required fields: `issue_title`, `deny-licenses`.  
Optional with defaults: `excluded_repos: []`, `docs_link: ""`.

---

## Checks

| # | Check | Data source | Pass condition |
|---|---|---|---|
| 1 | **Dependency Licenses** | GitHub Dependency Graph API (`/dependency-graph/sbom/generate-report`, async polling) | No dependency has an `spdxId` (`licenseConcluded ?? licenseDeclared`) matching an entry in `deny-licenses`. Packages with `spdxId` of `NOASSERTION`, `NONE`, or `null` are silently skipped. |

---

## Execution Flow

```
1. Read GITHUB_TOKEN from environment — exit with clear error if missing
2. Parse CLI arguments
3. Load config with js-yaml
4. Instantiate Octokit with the token
5. Fetch all repos in org (paginated):
     octokit.paginate(octokit.rest.repos.listForOrg, { org, type: "all" })
   Split into active (archived: false, not excluded), archived (archived: true, not excluded),
   and excluded (name in excluded_repos) lists
6. For each active repo (sequentially):
   a. GET /repos/{org}/{repo}/dependency-graph/sbom/generate-report → get `sbom_url`
      Poll `sbom_url` with auth headers until ready (202 → wait 2s; 302 → follow redirect and parse JSON):
      - Times out after 30 attempts (60s) — throws
      - 5xx responses: retry up to 3 times (2s delay between), then throw
      - Any other non-success status: throw
      - Empty or missing packages list: treated as passing (no violations)
      The dependency graph cannot be disabled, so any SBOM fetch failure is treated
      as a fatal error rather than a skip.
   b. Filter packages where spdxId is in deny-licenses
      (skip packages where spdxId is NOASSERTION / NONE / null)
   c. Violations present:
        - No open issue with matching title: create issue (unless --dry-run)
        - Open issue with matching title: update its body with current results (unless --dry-run)
   d. No violations:
        - Open issue with matching title: close it with a resolved comment (unless --dry-run)
   e. Print summary line to stdout
7. For each archived repo: print name under "Skipped (archived)" — no checks, no issue action
8. For each excluded repo: print name under "Skipped (configuration)" — no checks, no issue action
9. Always exit 0 — violations are expected, not errors. Only fatal errors (missing token,
   unreadable config, API failure) exit non-zero.
```

---

## Issue Lifecycle

| Repo state | Existing issue? | Action |
|---|---|---|
| Violations found | No open issue | Create issue |
| Violations found | Open issue exists | Update issue body with current violations |
| No violations | Open issue exists | Close issue with resolved comment |
| No violations | No open issue | No action |
| Archived (any) | — | No checks, no issue action |
| Excluded (any) | — | No checks run, no issue action |

The script only considers **open** issues. If a user manually closes the issue but the repo still has violations, a new issue will be created on the next run.

Issue lookup uses `octokit.rest.issues.listForRepo` filtered by `state: "open"` and matching `issue_title` from config.

### Issue body template

```markdown
## Dependency License Violation

The following dependencies use licenses that are not permitted:

| Package | Version | License |
|---------|---------|---------|
| some-lib | 1.2.3 | GPL-3.0 |
| another-lib | 0.5.0 | AGPL-3.0 |

Please review the [License Policy](<docs_link>) and replace or remove the dependencies above.

_This issue was automatically generated by the OSPO license scanner._
```

---

## Output / Reporting

```

Results
───────
✅ clean-repo            42 packages, 7 unique licenses
❌ repo-a                18 packages, 3 unique licenses
       Non-compliant: my-lib@1.0.0 (GPL-3.0)
       Non-compliant: other-lib@2.0.0 (AGPL-3.0)

Skipped (archived)
──────────────────
– old-repo
– archived-repo

Skipped (configuration)
───────────────────────
– excluded-repo
```

Each active repo prints one line with icon, repo name (padded/truncated to 20 chars), package count, and unique license count. Violations follow as indented `Non-compliant: package@version (SPDX-ID)` lines.

Icons: `✅` pass, `❌` fail (active repos). Archived and excluded repos are listed with `–` (no scan performed).

With `--debug`, an extra `No license info: N packages` line is printed under each repo when packages without an SPDX identifier are present.

When `--dry-run` is active and there are pending actions, a summary block is appended:

```
──── Dry-run: 1 issue would be created, 1 would be updated, 1 would be closed ────
  ✉️   create  repo-a
  ✏️   update  #17  repo-b
  ✔️   close   #42  repo-c
```

---

## Dependencies

| Tool | Purpose |
|---|---|
| `node` + `npm` | Run the script, install packages |
| `@octokit/rest` | GitHub API + issue management |
| `js-yaml` | Parse YAML config |

No additional tools required beyond what is already used by the other scripts.

---

## Unit Tests

Unit tests live in `scripts/license_scan.test.js` and run with Node's built-in test runner (`node --test`). No additional test framework required.

Each function is tested in isolation with fake API responses. Key scenarios:

- **Config loading:** valid config; missing `issue_title`; missing `deny-licenses`; `excluded_repos` absent (defaults to `[]`); `docs_link` absent (defaults to `""`)
- **SBOM parsing:** all packages clean; one denied license; multiple denied licenses; mixed denied/allowed; package with `NOASSERTION` spdxId (ignored); package with `NONE` spdxId (ignored); package with `null` spdxId (ignored); empty packages list (passes)
- **Issue body:** correct table rows generated; `docs_link` inserted correctly; empty docs_link omits link
- **SBOM fetch failures:** non-success status codes (404, 403, 5xx after retries, timeout) cause `fetchSbomPackages` to throw

### Integration test (against `ospo-sandbox`)

Requires `GITHUB_TOKEN`. Run via Makefile, not part of the unit test suite.

```makefile
test_license_scan:
    cd .. && node scripts/license_scan.js --org ospo-sandbox --config scripts/test-config/license_scan.yaml --debug
```

Test config lives at `scripts/test/license_scan.yaml` and targets the `ospo-sandbox` org.

---

## CI/CD Changes

`.github/workflows/license_scan.yml` setup:

- Node.js 22 setup step
- `npm ci` run from the `scripts/` directory
- Run step: `node scripts/license_scan.js --org allianz`
- Schedule: weekly (`0 0 * * 1` — every Monday at midnight UTC)
- `workflow_dispatch` for manual runs
- Pass the GitHub App token as `GITHUB_TOKEN` env var to the run step (secrets: `ALLIANZ_APP_ID`, `ALLIANZ_APP_PRIVATE_KEY`)
