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

## Project Structure

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

---

## CLI Interface

```
node scripts/archive_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--json <file>]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to scan for stale repos |
| `--config` | `config/archive_repos.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Simulate execution without creating issues, closing issues, or archiving repos |
| `--debug` | false | Print verbose output (computed dates, per-repo decisions) |
| `--json` | – | Also write the results to this file as JSON, see [JSON output](#json-output) |

Exit codes: `0` on success, `1` on missing `--org`, missing token, or fatal error.

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment. The default config path is resolved relative to the repo root, not the working directory.

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

## Issue Lifecycle

| Repo state | Existing issue? | Action |
|---|---|---|
| Stale | No open issue | Create warning issue |
| Stale | Open issue, grace period NOT expired | Log remaining grace period |
| Stale | Open issue, grace period expired | Archive the repository |
| Not stale | Open issue exists | Close the issue (repo became active again) |
| Not stale | No open issue | No action |
| Excluded | — | Skip entirely |
| Never pushed to | — | Skip |

The script only considers **open** issues. If a user manually closes the warning issue but the repo remains stale, a new issue will be created on the next run.

In dry-run mode, a repo that would get a new warning issue is treated as if the issue was created now, so the same run never also reports it for archival.

### Warning issue template

**Title:** `Inactive Repository Reminder`. Existing warning issues are found by this exact title.

**Body** (`${grace_period}` is replaced with the configured value):

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

When a repo becomes active again, the warning issue is closed without a comment.

### Archiving repositories

Once archived, only org admins can unarchive.

### OSPO summary issue

After processing all repos, the script maintains a single `Stale Repository Summary` issue in the `<org>/ospo` repository, listing every repo with a warning issue that is still in its grace period and the days left until archival:

| Repos in grace period? | Open summary issue? | Action |
|---|---|---|
| Yes | No | Create the summary issue |
| Yes | Yes | Update the issue body with the current list |
| No | Yes | Close the summary issue |
| No | No | No action |

If the `ospo` repository does not exist, the script exits with an error.

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

### Next warning issues

After the main output, the script prints the top 3 repos (sorted by fewest days remaining) that will be the next to receive a warning issue. Only repos without an existing open warning issue are included.

```
Next warning issues (top 3):
  repo-a    in 12 days
  repo-b    in 45 days
  repo-c    in 67 days
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

## JSON output

With `--json <file>` the script also writes its results to `<file>` in the common JSON format of the compliance report ([Tool file format](compliance_report_spec.md#tool-file-format)). The directory is created if needed. The text output, the issues and the exit code are the same as without `--json`; the last line of the output is `JSON written to <file>`. With `--dry-run`, the file is still written.

The file has these keys:

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | Script name, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | `Inactive Repository Reminder` |
| `results` | One row per repository and check: `repo`, `check`, `name`, `result` (`pass`, `fail` or `na`), `score` (always `null`), `reason` (always filled), `details` (list of lines) |
| `catalogue` | One entry per check ID: `name` and `documentation` (`url` to the heading below, pinned to `ospo_sha`; `short` rule; `fix`) |
| `skipped` | Repositories without results: `repo` and `reason` |
| `errors` | Always `[]`: errors abort the run, and then no file is written |

Each repository whose last push was evaluated has two results. `skipped` lists, in this order:

| Reason | Repositories |
|---|---|
| `archived in this run` | Archived because the grace period expired. With `--dry-run` such a repository is not archived and stays active: it gets its two results (`recent-activity` = `fail`, `activity-checked` = `pass`), each reason ending in `would be archived in this run (dry-run)` |
| `no push activity yet` | No `pushed_at` |
| `archived` | Already archived |
| `excluded_repos` | In `excluded_repos` |

| Check ID | Name |
|---|---|
| `archive/recent-activity` | Recent Activity |
| `archive/activity-checked` | Activity Checked |

### Recent Activity

The repository had a push within `warn_after`. A stale repository fails; the reason gives the last push, the warning issue (existing or created in this run) and the days until archival.

How to fix: push to the repository (an empty commit is enough) if the project is still maintained.

### Activity Checked

`archive_repos` read the last push of the repository in this run. It passes for every repository with a result; a repository that is excluded or never evaluated has no result.

How to fix: OSPO: remove the repository from `excluded_repos` in the archive_repos configuration, or fix the error that stopped the check.
