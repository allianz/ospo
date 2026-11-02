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

## Project Structure

```
scripts/
  package.json          # shared for all JS scripts in this repo
  package-lock.json
  node_modules/
  lint_repos.js
```

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

Exit codes: `0` whenever the run completes (lint failures are expected, not errors), `1` on missing `--org`, missing token, or fatal error.

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment and `git` on the `PATH`. The default config path and `lint_cache/` are resolved relative to the repo root, not the working directory.

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
# the license GitHub detects for the repo. A missing or unidentified
# license (NOASSERTION) is always rejected regardless of this list.
allowed_licenses:
  - Apache-2.0
  - MIT
  - CC-BY-4.0
  - CC0-1.0

# File checks run against the local clone. Each entry must match at least one
# file in the specified search_paths. pattern is a case-insensitive prefix glob
# (e.g. README* matches README.md). description is used as the check name in
# issue body and output. search_paths defaults to ["."] if omitted.
# min_chars (optional): if set, the matched file must also be at least this many
# chars; a file that exists but is smaller fails with "File exists but is too short
# (<actual> chars; minimum is <min_chars>)".
required_files:
  - pattern: "README*"
    description: "Readme File"
    min_chars: 300
  - pattern: "CONTRIBUTING*"
    search_paths: [".", ".github", "docs"]
    description: "Contributing File"
  - pattern: "LICENSE*"
    description: "License File"
  - pattern: "NOTICE*"
    description: "Notice File"
  - pattern: "AUTHORS*"
    description: "Authors File"

# Minimum and maximum character length for repository descriptions (inclusive).
# Descriptions outside this range fail the check. Defaults: min: 30, max: 150.
description_length:
  min: 30
  max: 150

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
| 1 | **Description** | GitHub API | `description` is non-null, non-empty, and between `description_length.min` and `description_length.max` chars (inclusive) |
| 2 | **Topics** | GitHub API | Between 1 and 5 topics assigned; all topics must be in `allowed_topics` |
| 3 | **License type** | GitHub API | The license GitHub detects is in `allowed_licenses`; fails with a clear message if no license is detected or GitHub cannot identify it (`NOASSERTION`, e.g. custom license text) |
| 4 | **Required files** | Local clone | Each `required_files` entry matches at least one file in the specified `search_paths`; if `min_chars` is set the matched file must also meet that size threshold |

Checks 1, 2, and 3 use only API data (no clone needed). Check 4 requires the local clone.

Active repos are shallow-cloned into `lint_cache/` in parallel batches of 5. Existing clones are updated in place; a clone that fails to update is deleted and re-cloned. Archived repos are not cloned, so they only get checks 1–3.

---

## Issue Lifecycle

| Repo state | Existing issue? | Action |
|---|---|---|
| Non-compliant | No open issue | Create issue |
| Non-compliant | Open issue exists | Update issue body with current check results |
| Compliant | Open issue exists | Close issue with resolved comment |
| Compliant | No open issue | No action |
| Archived (any) | — | No issue action |
| Excluded (any) | — | No checks run, no issue action |

The script only considers **open** issues. If a user manually closes the issue but the repo remains non-compliant, a new issue will be created on the next run.

Archived repos are checked for compliance (checks 1–3 only) and shown in a separate output section, but no issues are ever created or closed for them.

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
──── Dry-run: 2 issues would be created, 1 would be updated, 1 would be closed ────
  ✉️   create  another-repo
  ✉️   create  fourth-repo
  ✏️   update  #17  fifth-repo
  ✔️   close   #42  third-repo
```
