# Spec: advisories_check implementation

## Motivation

Vulnerabilities that were reported privately must be published within a reasonable period of time. Every report becomes a GitHub Security Advisory, so the time from its creation to its publication shows whether this happened. This script measures that time for every repository and writes the result for the compliance report.

## Scope

The script:

- lists the repositories of the organisation;
- reads the **published** security advisories of every active repository (public data only);
- writes one result per active repository to the JSON file.

JSON only. Out of scope:

- Issues. A late publication is a past event that the project team cannot fix any more; it disappears from the check after `lookback`. The script never opens, updates or closes an issue.
- Any other change on GitHub. The script only reads.
- Advisories in `triage` or `draft` state and closed advisories. They are not public.

---

## CLI Interface

```
node scripts/advisories_check.js --org <org> --json <file> [--config <file>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization whose repositories are checked |
| `--json` | required | Write the results to this file, see [JSON output](#json-output). The file is the only product of the script |
| `--config` | `config/advisories_check.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes |
| `--debug` | false | Also print the lookback cutoff and the repositories without advisories |

Exit codes: `0` on success, `1` on missing `--org` or `--json`, missing token, invalid config, or fatal error (any API error other than a 404 on the advisories of a repository, see [JSON output](#json-output)).

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment. The token needs read access to the repositories' security advisories **(verify** the GitHub App permission; published advisories of public repositories are public**)**. The default config path is resolved relative to the repo root, not the working directory.

---

## Configuration File

```yaml
# Repos to skip. Keep this empty: the compliance report counts a skipped
# repository as failing this check.
excluded_repos: []

# Maximum days from creation to publication of an advisory.
max_days: 90

# Advisories published within this period are checked.
lookback: "12 months"
```

| Field | Required | Description |
|---|---|---|
| `excluded_repos` | no (default `[]`) | Repository names without results |
| `max_days` | no (default `90`) | Positive integer |
| `lookback` | no (default `"12 months"`) | `"<N> <unit>"`, unit `day(s)`, `month(s)` or `year(s)` |

### Validation

- `max_days` that is not a positive integer: `Config field max_days must be a positive integer (in <file>)`.
- Invalid `lookback`: `Invalid relative date: "<value>"`.

An empty file is valid and uses the defaults.

---

## Run log

A short log for the workflow run. The JSON file holds the results.

```
Active repositories: 3 (archived: 1, excluded: 0)
  pdf-render-service: 1 of 1 advisory published later than 90 days: GHSA-p2w8-xr6j-9cq4 after 130 days
  pricing-engine: 1 advisory published in the last 12 months: GHSA-7q4x-2m9c-h3vf after 18 days
Late publications: 1 repository

JSON written to out/advisories_check.json
```

Only repositories with advisories in the lookback window are listed. If none was late, the summary line is `All advisories published in time.` A repository whose advisories return 404 is listed with the reason of its `errors` entry, and a line `Not readable (in errors): N repositories` follows. With `--debug`, a line `Advisories published since <date>, at most <max_days> days after creation` follows the first line, and every repository is listed.

---

## JSON output

The file is in the common JSON format of the compliance report ([draft, section 1.6](compliance_implementation_draft.md#16-common-json-format)). The directory is created if needed. A 404 on the advisories of a repository (private repository, or a token without advisory permission) goes to `errors`; any other API error aborts the run, and then no file is written.

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | `advisories_check`, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | Always `null`: the script opens no issues |
| `results` | One row per active repository whose advisories could be read: `repo`, `check`, `name`, `result` (`pass` or `fail`), `score` (always `null`), `reason` (always filled), `details` (one line per advisory) |
| `catalogue` | One entry: `name` and `documentation` (`url` to the heading below, pinned to `ospo_sha`; `short` rule; `fix`) |
| `skipped` | Repositories without results: `repo` and `reason` (`archived` or `excluded_repos`) |
| `errors` | One row per repository whose advisories returned 404: `repo`, `check`, `reason` ("Security advisories not readable (request returned 404: private repository or missing permission)"). The report treats it as "no data", never as `pass` |

Results are sorted by repository name.

| Check ID | Name |
|---|---|
| `advisories/published-in-time` | Advisories Published in Time |

### Advisories Published in Time

Every security advisory of the repository published within `lookback` was published at most `max_days` days after its creation. The days are whole days from `created_at` to `published_at`, rounded down. A repository without such an advisory passes. Data source: `GET /repos/{owner}/{repo}/security-advisories?state=published`.

- `reason` names the advisories and their days to publication: "1 advisory published in the last 12 months: GHSA-7q4x-2m9c-h3vf after 18 days", or on failure only the late ones: "1 of 2 advisories published later than 90 days: GHSA-p2w8-xr6j-9cq4 after 130 days". Without advisories: "No advisory published in the last 12 months".
- `details` has one line per advisory in the window, sorted by publication: `Info: GHSA-… created 2026-05-02, published 2026-05-20 (18 days)`, or `Warn: …` for a late one.

Limits: advisories that are never published never fail the check. `created_at` is taken as the time of the private report **(verify)**. Vulnerabilities reported through other channels are only measured from the moment an advisory is created.

How to fix: project team with the OSPO: publish advisories within `max_days` days of the report. A late publication counts for `lookback`.
