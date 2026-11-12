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
node scripts/lint_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--json <file>]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to lint |
| `--config` | `config/lint_repos.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Run checks but do not create/close issues |
| `--debug` | false | Print verbose output |
| `--json` | – | Also write the results to this file as JSON, see [JSON output](#json-output) |

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
# (e.g. README* matches README.md); a list of patterns matches a file that fits
# any of them. name is used as the check name in
# issue body and output. search_paths defaults to ["."] if omitted.
# min_chars (optional): if set, the matched file must also be at least this many
# chars; a file that exists but is smaller fails with "File exists but is too short
# (<actual> chars; minimum is <min_chars>)".
# json_only (optional, default false): if true, the check is written to the --json
# file only; it is never listed in the issue or the result line.
# why (required): why the file matters, in plain words. Shown in the issue below
# the finding of a failed check; not written to --json. Also required for json_only
# entries, so the text is there if the entry is ever shown in the issue.
required_files:
  - pattern: "README*"
    name: "Readme File"
    min_chars: 300
    why: "The README is the entry point of the project: what it does, how to use it and where to get help."
  - pattern: "CONTRIBUTING*"
    search_paths: [".", ".github", "docs"]
    name: "Contributing File"
    why: "It tells others how to propose changes and what is expected of a contribution."
  - pattern: "LICENSE*"
    name: "License File"
    why: "Without the license text nobody may legally use, change or share the code."
  - ...
  - pattern: ["DEVELOPMENT*", "DEVELOPER*"]
    search_paths: [".", "docs", ".github"]
    name: "Development File"
    min_chars: 300
    json_only: true
    why: "Documenting how to build and test the project is common best practice. It lets others reproduce the build and check their changes before they propose them."

# Files no repository may contain, e.g. organisation defaults from the .github
# repository that a file of the repository would override. Same fields as
# required_files (no min_chars); the check fails when any search path contains a
# matching file, and the failure lists every file found.
forbidden_files:
  - pattern: "CODE_OF_CONDUCT*"
    search_paths: [".", ".github", "docs"]
    name: "Code of Conduct"
    why: "The [Allianz Code of Conduct](https://github.com/allianz/.github/blob/main/CODE_OF_CONDUCT.md) applies to all repositories, and GitHub shows it automatically. A file of your own would replace it."
  - pattern: "MAINTAINERS*"
    search_paths: [".", ".github", "docs"]
    name: "Maintainers File"
    why: "A MAINTAINERS file is easily confused with AUTHORS, the legally required list of copyright holders. It also puts the names of individuals into the repository, which is personal data under the GDPR."
  - pattern: "SECURITY*"
    search_paths: [".", ".github", "docs"]
    name: "Security Policy"
    json_only: true
    why: "The [Allianz security policy](https://github.com/allianz/.github/blob/main/SECURITY.md) applies to all repositories, and GitHub shows it automatically. A file of your own would replace it. Add one only if the project has its own vulnerability reporting requirements."

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
| 4 | **Required files** | Local clone | Each `required_files` entry matches at least one file in the specified `search_paths`; if `min_chars` is set the matched file must also meet that size threshold. Entries with `json_only: true` are JSON only |
| 5 | **Public repository** (JSON only) | GitHub API | `visibility` is `public` |
| 6 | **Issues enabled** (JSON only) | GitHub API | `has_issues` is `true` |
| 7 | **Forbidden files** | Local clone | No `forbidden_files` entry matches a file in its `search_paths`. Entries with `json_only: true` are JSON only |

Checks 1, 2, 3, 5 and 6 use only API data (no clone needed). Checks 4 and 7 require the local clone.

Checks 5 and 6 are **JSON only**: they are written to the `--json` file, but are not listed in the issue or the result line, and they never cause an issue to be opened. Project teams have no influence on them: the visibility and the Issues setting are controlled centrally by the OSPO, so an issue would ask the team for something it cannot do. The results are evidence for the compliance report and audits only. They are only run for active repositories.

A `required_files` or `forbidden_files` entry with `json_only: true` is JSON only in the same way: the file is reported in the compliance report, but its absence never opens, updates or keeps open an issue. A repository that fails only JSON-only checks counts as compliant for the issue and shows `✅` in the result line. The production configuration uses this for `DEVELOPMENT*` and `DEVELOPER*` (Allianz AZ.05, a SHOULD) and for the forbidden `SECURITY*` (a SHOULD NOT of the Allianz standards, AZ.07: a project may have a documented reason for its own policy).

Active repos are shallow-cloned into `lint_cache/` in parallel, at most 5 at a time. Existing clones are updated in place; a clone that fails to update is deleted and re-cloned. Archived repos are not cloned, so they only get checks 1–3.

---

## Issue Lifecycle

| Repo state | Existing issue? | Action |
|---|---|---|
| Non-compliant | No open issue | Create issue |
| Non-compliant | Open issue exists | Update issue body with current check results |
| Compliant | Open issue exists | Close issue with resolved comment |
| Compliant | No open issue | No action |
| Issues disabled (any) | — | No issue action; if a check fails, the warning `⚠️  <repo>: issues are disabled, no issue opened` is printed after its result line |
| Archived (any) | — | No issue action |
| Excluded (any) | — | No checks run, no issue action |

The script only considers **open** issues. If a user manually closes the issue but the repo remains non-compliant, a new issue will be created on the next run.

Archived repos are checked for compliance (checks 1–3 only) and shown in a separate output section, but no issues are ever created or closed for them.

### Issue body template

Every failed check shows its finding in the Details column and, below it after `**Why:**`, why the check matters: the `why` text of a `required_files` or `forbidden_files` entry, or for the description, topics and license checks a built-in text per failure case (`WHY` in `lint_repos.js`, listed in the sections of these checks; not configurable). People who get the issue rarely read the standards guide, so the issue itself has to explain the rule. The finding and the `why` text are put on one line, `|` is escaped so it cannot break the table, and `<` and `>` are escaped so GitHub shows them as text (e.g. `<Project>`). Passed checks have an empty Details cell.

```markdown
## Mandatory Repository Configuration

The following compliance checks failed for this repository:

| Check | Status | Details |
|-------|--------|---------|
| Repository Description | ❌ Failed | No description set<br>**Why:** GitHub shows the description, not the README, in the search results and in the GitHub CLI, so without it people cannot see what the project does. |
| Repository Topics     | ✅ Passed | |
| README File           | ✅ Passed | |
| CONTRIBUTING File     | ❌ Failed | File not found in ., .github, docs<br>**Why:** It tells others how to propose changes and what is expected of a contribution. |
| License File          | ✅ Passed | |
| License Type          | ❌ Failed | 'WTFPL' is not in the approved list<br>**Why:** Only the approved licenses may be used for Allianz open source projects. |
| Maintainers File      | ❌ Failed | MAINTAINERS.md must not exist; delete it<br>**Why:** A MAINTAINERS file is easily confused with AUTHORS, the legally required list of copyright holders. It also puts the names of individuals into the repository, which is personal data under the GDPR. |

Please review the [Mandatory Repository Configuration](<docs_link>) guide and address the issues above.

_This issue was automatically generated by the OSPO linting bot._
```

---

## Output / Reporting

With `--debug`, cloning progress is printed first, followed by a `Results` header and one line per repo. Failing repos additionally show the reason for each failure indented below:

```
Cloning 3 repositories (5 at a time)...
  Cloning my-repo...
  Cloning another-repo...
  Updating third-repo...

Results
───────
✅ my-repo
❌ another-repo  [Description, Contributing File]
     Repository Description: No description set
     Contributing File: File not found in ., .github, docs
✅ third-repo
```

Without `--debug`, only the `Results` header and repo lines are printed. The failing check names are listed in brackets for non-compliant repos. The JSON-only checks (5 and 6) never appear in the brackets. A failing repo with issues disabled gets the line `⚠️  <repo>: issues are disabled, no issue opened` below its result line. Archived repos appear in a separate section after active repos. No files are written to disk, except with `--json`.

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

---

## JSON output

With `--json <file>` the script also writes its results to `<file>` in the common JSON format of the compliance report ([Tool file format](compliance_report_spec.md#tool-file-format)). The directory is created if needed. The text output, the issues and the exit code are the same as without `--json`; the last line of the output is `JSON written to <file>`. With `--dry-run`, the file is still written.

The file has these keys:

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | Script name, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | Title of the per-repository issue |
| `results` | One row per repository and check: `repo`, `check`, `name`, `result` (`pass`, `fail` or `na`), `score` (always `null`), `reason` (always filled), `details` (list of lines) |
| `catalogue` | One entry per check ID: `name` and `documentation` (`url` to the heading below, pinned to `ospo_sha`; `short` rule; `fix`) |
| `skipped` | Repositories without results: `repo` and `reason` |
| `errors` | Always `[]`: errors abort the run, and then no file is written |

Every check of an active repository is written. Archived repositories are listed in `skipped` with reason `archived` (their metadata checks only appear in the text output), excluded repositories with reason `excluded_repos`.

| Check ID | Name |
|---|---|
| `lint/description` | Repository Description |
| `lint/topics` | Repository Topics |
| `lint/license-type` | License Type |
| `lint/public` | Public Repository |
| `lint/issues-enabled` | Issues Enabled |
| `lint/<prefix>` | One per `required_files` entry, also for `json_only` entries. The ID is the pattern prefix in lower case, from the first pattern of a list (`CONTRIBUTING*` → `lint/contributing`, `["DEVELOPMENT*", "DEVELOPER*"]` → `lint/development`), the name is its `name` (default: the patterns, joined with "or"). Two entries with the same ID are a configuration error |
| `lint/no-<prefix>` | One per `forbidden_files` entry, also for `json_only` entries. The ID is built like `lint/<prefix>` with `no-` in front (`CODE_OF_CONDUCT*` → `lint/no-code-of-conduct`), the name is its `name` (default: "No " and the patterns). Two entries with the same ID are a configuration error |

The `short` and `fix` texts in the catalogue are built from the configuration (lengths, licenses, patterns, search paths).

### Repository Description

The description is set and has `description_length.min` to `description_length.max` characters.

Why, shown in the issue per failure case:

| Finding | Why |
|---|---|
| No description set | GitHub shows the description, not the README, in the search results and in the GitHub CLI, so without it people cannot see what the project does. |
| Description too short | A description of a few words does not tell people what the project does. Describe its purpose in one full sentence. |
| Description too long | GitHub cuts long descriptions in the search results and in the CLI, so the end of the text is not shown. |

How to fix: set a description of that length in the About section of the repository.

### Repository Topics

The repository has 1 to 5 topics, all from `allowed_topics` (any topic if the list is empty).

Why, shown in the issue per failure case:

| Finding | Why |
|---|---|
| No topics set | Topics are used to filter the projects of the organisation and for statistics across it. A repository without topics shows up in neither. |
| Too many topics | With too many topics a project shows up under filters that hardly apply to it. Choose the topics that describe it best. |
| Invalid topic(s) | Filtering and statistics only work properly if all projects use topics from a common taxonomy. With a topic outside the approved list (e.g. "k8s" instead of "kubernetes"), the project does not show up in the result lists. |

How to fix: add 1 to 5 topics from the approved list in the About section of the repository.

### License Type

The license GitHub detects is in `allowed_licenses`. A missing or unidentified license (`NOASSERTION`) fails.

Why, shown in the issue per failure case:

| Finding | Why |
|---|---|
| No license detected | Without a license nobody may legally use, change or share the code, even though the repository is public. |
| Custom license text detected (`NOASSERTION`) | GitHub cannot show the license, so users and tools cannot see the terms. This happens when the license text was changed or combined with other text. |
| Not in the approved list | Only the approved licenses may be used for Allianz open source projects. |

How to fix: use one of the approved licenses with its unmodified license text, so GitHub can detect it.

### Public Repository

The repository's visibility is `public`. Private and internal repositories fail. JSON only, not listed in the issue: the project team cannot change the visibility.

How to fix: not fixable by the project team: the OSPO makes the repository public or archives it.

### Issues Enabled

Issues are enabled for the repository (`has_issues`). JSON only, not listed in the issue: the project team cannot change the Issues setting.

How to fix: not fixable by the project team: the OSPO enables Issues for the repository.

### Readme File

A file `README*` exists in the root, with at least `min_chars` characters.

How to fix: add a README file with at least that many characters to the root.

### Contributing File

A file `CONTRIBUTING*` exists in `.`, `.github` or `docs`.

How to fix: add a CONTRIBUTING file to one of these directories.

### License File

A file `LICENSE*` exists in the root.

How to fix: add a LICENSE file to the root.

### Notice File

A file `NOTICE*` exists in the root.

How to fix: add a NOTICE file to the root.

### Authors File

A file `AUTHORS*` exists in the root.

How to fix: add an AUTHORS file to the root.

### Development File

A file `DEVELOPMENT*` or `DEVELOPER*` exists in `.`, `docs` or `.github`, with at least `min_chars` characters. JSON only (`json_only: true`): reported in the compliance report, not listed in the issue. Its `why`: "Documenting how to build and test the project is common best practice. It lets others reproduce the build and check their changes before they propose them."

How to fix: add a DEVELOPMENT.md with at least that many characters to one of these directories, describing how to build and test the project.

### Code of Conduct

No file `CODE_OF_CONDUCT*` exists in `.`, `.github` or `docs` (`forbidden_files`). The Code of Conduct is defined once for the organisation in its `.github` repository, and GitHub shows it for every repository without a file of its own. A file in any of these directories would override it. A failure lists every file found, e.g. `.github/CODE_OF_CONDUCT.md must not exist; delete it`.

How to fix: delete the file, so the Code of Conduct of the organisation applies.

### Maintainers File

No file `MAINTAINERS*` exists in `.`, `.github` or `docs` (`forbidden_files`). A MAINTAINERS file is easily confused with AUTHORS, which names the copyright holders the copyright statement in NOTICE refers to and is a legal requirement. It would also put the names of individuals into the repository, which is personal data under the GDPR.

How to fix: delete the file.

### Security Policy

No file `SECURITY*` exists in `.`, `.github` or `docs` (`forbidden_files`). The security policy is defined once for the organisation in its `.github` repository, and GitHub shows it for every repository without a file of its own. A file in any of these directories would override it. JSON only (`json_only: true`): reported in the compliance report, not listed in the issue, because a project may have its own vulnerability reporting requirements.

How to fix: delete the file, so the security policy of the organisation applies, unless the project has its own vulnerability reporting requirements.
