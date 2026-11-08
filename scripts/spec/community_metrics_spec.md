# Spec: community_metrics implementation

## Motivation

The compliance and Scorecard reports show what is missing. The [community report](community_report_spec.md) shows what is growing: reach, contributors and activity of the open source projects under github.com/allianz, month by month. This script collects the numbers: the metrics of the previous calendar month for every public repository and the totals of the organisation, written to one tool file.

Principles:

- **No people.** No person is named or ranked. The file holds counts only, no logins (works council and data protection: a ranking of employees by activity is behaviour monitoring). Logins are kept in memory only, to count people once across repositories.
- **GitHub only.** Every number comes from the GitHub REST API. No package registries, no third-party services.
- **Read-only.** No issues, no writes to GitHub.

## Scope

The script:

- lists the repositories of the organisation and its members;
- reads per repository in scope the contributor statistics, issues, pull requests, releases and traffic;
- writes `results/community.json` (`--json`), read by [`community_report.js`](community_report_spec.md).

Out of scope:

- Package downloads (npm, PyPI, Maven Central) and dependents: not available from GitHub, and the lookup by repository URL is unreliable (forks and copies claim the same URL).
- Time to first response, bus factor, referrers and popular paths.
- Rankings of projects or people.

## CLI Interface

```
node scripts/community_metrics.js --org <org> --json <file> [--config <file>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization |
| `--json` | required | Write the metrics to this file (`results/community.json` in `make create_reports`) |
| `--config` | `config/report/community_metrics.yaml` | Path to config file |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes |
| `--debug` | false | Also print every repository with its numbers |

Exit codes: `0` on success, `1` on missing `--org` or `--json`, missing token, invalid config, or a fatal error. A `403` or `404` on one metric of one repository (and contributor statistics that are not ready, see [Rules](#rules)) goes to `errors` and leaves that metric `null`; any other HTTP error is fatal.

Token permissions (GitHub App): *Metadata: read*, *Contents: read*, *Issues: read*, *Pull requests: read*, *Administration: read* (traffic), and *Members: read* on the organisation (otherwise only public members are listed and every other employee counts as external).

## Configuration File

```yaml
# Repositories to leave out of the community report.
excluded_repos: [".github", "ospo"]

# Logins that are bots without the [bot] suffix (service accounts).
bots: []

# A project is active with a push within this period before the end of the month.
active_within: "90 days"

# Milestones of the organisation, celebrated by the report.
milestones:
  visitors: [1000, 2500, 5000, 10000]    # unique visitors in the last 14 days, summed over the projects
  stars: [1000, 2500, 5000, 10000]
  public_projects: [25, 50, 100]
  contributors: [100, 200, 500, 1000]
  external_contributors: [10, 25, 50, 100]
```

All fields are optional; the values above are the defaults. A metric left out of `milestones` keeps its default levels. Errors name the field:

- `excluded_repos` and `bots` are lists of strings;
- `active_within` is `"<N> day(s)|month(s)|year(s)"`;
- `milestones` is a map whose keys are the five metrics above, each a list of positive integers in increasing order.

## Period

The **period** is the calendar month before the month of the run (UTC): a run on 1 Nov 2026 collects October 2026 (`from` `2026-10-01T00:00:00Z`, `to` `2026-11-01T00:00:00Z`, exclusive). The report folder is the month of the run (`reports/2026-11/`), like the other reports.

## Repositories in scope

Public, not archived, not a fork, not in `excluded_repos`. Forks are left out because their history and contributors are mostly upstream. Every other repository is listed under `skipped` with its reason, checked in this order: `excluded_repos`, `private` (also internal), `archived`, `fork`.

## Internal and external

- **Internal:** member of the organisation at the time of the run (`GET /orgs/{org}/members`, once). Logins are compared case-insensitively.
- **External:** every other GitHub user.
- **Bot:** `type` `Bot`, a login ending in `[bot]`, or a login in `bots`. Bots are never counted: not as contributors, not in commits, not as authors of issues and PRs. This also removes the issues the OSPO scripts open themselves.

## Metrics per repository

Calls per repository: `/stats/contributors`, `/issues?state=all&since=<from>`, `/pulls?state=all&sort=updated&direction=desc` (paged until the first pull request updated before `from`), `/releases`, `/traffic/views`, `/traffic/clones`. Stars, forks, description, `created_at` and `pushed_at` come from the repository list.

| Key | Metric | Source and rule |
|---|---|---|
| `stars`, `forks` | Totals at the time of the run | repository list |
| `new_project` | Created in the period | `created_at` |
| `active` | A push within `active_within` before `to` (a later push counts too) | `pushed_at` |
| `contributors` | Authors with at least one commit, all-time | `/stats/contributors` |
| `new_contributors` | Authors whose first week with a commit in this repository is in the period | `/stats/contributors` |
| `active_contributors` | Authors with a commit in the period, or who opened an issue or PR in the period | `/stats/contributors`, `/issues`, `/pulls` |
| `commits` | Commits in the weeks of the period | `/stats/contributors` |
| `prs.opened`, `prs.merged`, `prs.closed_unmerged` | PRs opened (`created_at`), merged (`merged_at`) and closed without merge (`closed_at`) in the period | `/pulls` |
| `issues.opened`, `issues.closed` | Issues (not PRs) opened and closed in the period | `/issues` |
| `releases.period`, `releases.total`, `releases.tags` | Published releases in the period (tags oldest first), and all-time; drafts not counted | `/releases` |
| `release_downloads` | Sum of `download_count` of all assets of the published releases, all-time | `/releases` |
| `traffic.views`, `.visitors`, `.clones`, `.cloners` | Views, unique visitors, clones, unique cloners of the last 14 days | `/traffic/views`, `/traffic/clones` |
| `traffic.from`, `traffic.to` | The window GitHub returned | first and last day of the responses (null without days) |

People counts are `{ internal, external }`. A metric whose call failed is `null`; `active_contributors` is `null` when the statistics or the issues/PRs failed.

### Rules

- **Weeks.** `/stats/contributors` returns weekly buckets (`w`, start of the week, Sunday 00:00 UTC). A week belongs to the month in which it starts. Commits, new and active contributors use the same rule.
- **`202 Accepted`.** GitHub computes the statistics in the background: the script asks again every 3 seconds (injected `sleep`, as `license_scan` does for SBOMs), at most 10 times, then writes an `errors` entry and leaves the contributor metrics `null`. `204` (empty repository) gives zeros.
- **Issues disabled.** `/issues` answers `410`: zero issues, no error. Pull requests are read from `/pulls`, so they count either way.
- **`since`** returns everything updated since `from`, so everything created, merged or closed in the period is included.

## Totals of the organisation

Sums of the repositories, except for people: contributors are counted **once** across all repositories (union of logins in memory, not written).

- `public_projects` (repositories in scope), `new_projects`, `active_projects`, `stars`, `forks`, `commits`, `releases` (in the period), `release_downloads`, `prs_merged` (`{ internal, external }`).
- `contributors`: authors with a commit in any repository in scope.
- `new_contributors`: the earliest first week of the author over **all** repositories is in the period. Someone contributing for years to project A and for the first time to project B is new in B, but not new in the organisation.
- `active_contributors`: union over all repositories.
- `traffic` (`views`, `visitors`, `clones`, `cloners`): sums over the repositories with traffic, `null` if none has any. A person visiting two repositories counts twice.

A repository with a metric in `errors` adds nothing to that total.

## Run log

```
Period: October 2026 (2026-10-01 – 2026-10-31)
Repositories: 14 in scope (skipped: 3 private, 2 archived, 1 fork, 2 excluded)
Stars: 2,431 · Forks: 512 · Contributors: 318 (external 96)
October: 14 new contributors (external 9), 61 active, 742 commits, 156 PRs merged, 11 releases
Unique visitors: 4,145 · Unique cloners: 1,093 (last 14 days)
Not complete (in errors): 1 repository
  mobile-sdk-ios traffic: Traffic not readable (request returned 403: missing permission)

JSON written to results/community.json
```

The `Not complete` block appears only with errors. With `--debug`, the number of members and the start of the active window follow the `Repositories:` line, and one line per repository follows: `  claims-engine: 1,204 stars, 25 contributors (4 external), 45 commits, 12 PRs merged, 1 release, 985 visitors`.

## JSON output

The common tool file (header from `buildHeader`: `tool` `community_metrics`, `run_at`, `org`, `ospo_sha`, `config_file`, `config_sha256`, `run_url`, `issue_title` `null`), with `results` `[]` and `catalogue` `{}` (no checks, so the common validation of the reports applies unchanged), then:

| Key | Content |
|---|---|
| `skipped` | `repo`, `reason` |
| `errors` | `repo`, `metric` (`contributors`, `issues`, `prs`, `releases`, `traffic`), `reason` |
| `period` | `month` (`2026-10`), `from`, `to` |
| `levels` | `milestones` and `active_within` from the config (so the report needs no config) |
| `totals` | The totals of the organisation |
| `repositories` | One entry per repository in scope, sorted by name: `repo`, `description`, `created_at`, `pushed_at` and the metrics above |
| `releases` | The releases of the period: `repo`, `tag`, `date`, sorted by date and repository |

No logins anywhere in the file.

## Limits

- Contributors are commit authors on the default branch with a linked GitHub account. Authors whose email is not linked to an account are not counted.
- `/stats/contributors` covers the top authors only (GitHub limit, to verify: 100 per repository).
- Commit counts follow weekly buckets, so a month counts 4 or 5 weeks.
- Traffic covers only the last 14 days at the time of the run, not the month.
- Internal is org membership at the time of the run. An employee who is not a member counts as external; a former member counts as external.
- `new_project` is the creation date. A repository made public later is not "new" (GitHub has no publication date outside the audit log).
- `active` uses `pushed_at` (the latest push to any branch), not the commits of the default branch.

## Make target

`make test_community_metrics` runs the script against `ospo-sandbox` with `scripts/test-config/report/community_metrics.yaml`; `make dry_run_community_metrics` against `allianz`. `make create_reports` runs it with the other tools (`--json $(JSON_DIR)/community.json`); a failing run leaves no file, and the community report shows "no data".

## Open points

- Confirm the App permissions *Administration: read* (traffic) and *Members: read*.
- Verify the author limit of `/stats/contributors`.
- Should employees who are not org members count as internal (e.g. a list of logins or email domains)?
- Milestone levels: the defaults are a first guess.
