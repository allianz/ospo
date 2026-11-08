# Spec: scorecard_report implementation

## Motivation

[`scorecard_check`](scorecard_check_spec.md) writes all 18 OpenSSF Scorecard checks per active repository, with Scorecard's `score`, `reason` and `details`, the OSPO verdict (`pass`, `fail`, `na`) and the overall score per repository. The compliance reports use only the checks mapped to a requirement and ignore the overall score. This script turns the whole tool file into a monthly Scorecard report: one self-contained `scorecard-data.json` and the HTML report `scorecard-report.html` rendered from it, with the trend of the overall scores month by month. Every number of the report can be traced to `scorecard-data.json`.

## Scope

The script:

- reads `scorecard.json` from one directory and validates it;
- drops the repositories that are archived;
- computes the scope and the summary (average and median overall score, check results);
- carries the score history forward from the previous month's report;
- writes `scorecard-data.json` and `scorecard-report.html` into the month folder of the reports directory, next to the compliance reports.

Out of scope:

- Any call to GitHub, git or Scorecard. The script reads local files only. `make create_reports` runs `scorecard_check` first.
- Requirements, statuses and notes. They are part of the compliance report.
- A Markdown report.

---

## CLI Interface

```
node scripts/scorecard_report.js --org <org> --dir <dir> [--reports <dir>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | Organisation of the run. A tool file of another organisation is invalid |
| `--dir` | required | Directory with `scorecard.json` (`results/` in `make create_reports`). Only read |
| `--reports` | `reports/` of the repo | Reports directory. Both files are written to `<reports>/<YYYY-MM>/` |
| `--config` | none | Accepted like in every script. Not used: the script has no configuration |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes on GitHub |
| `--debug` | false | Also print every scanned repository with its overall score and number of failed checks |

Exit codes: `0` on success, also when `scorecard.json` is missing or invalid ("no data" is a valid report). `1` on a missing flag, an invalid previous `scorecard-data.json`, or a fatal error.

No token is needed.

---

## Steps

### Read and validate

`<dir>/scorecard.json` gets an `input` entry with `status`:

- `missing`: the file does not exist.
- `invalid`: not valid JSON, against the common format (the same checks as the compliance report, see [compliance_report_spec.md](compliance_report_spec.md#read-and-validate), with `tool` `scorecard_check`), or `repositories` that is not a list, an entry without `repo`, a `score` that is not a number, or a repository listed twice. `problems` lists the reasons.
- `ok`: the file is used.

A missing or invalid file gives an empty report: no repositories, no results, and a data-health box.

### Scope

- **archived:** repositories listed under `skipped` with reason `archived` or `archived in this run`;
- **active:** every other repository that appears in `results`, `repositories`, `skipped` (e.g. `excluded_repos`) or `errors`.

Results and repositories of archived repositories are dropped. An active repository without an entry in `repositories` was not scanned: it was excluded in the configuration or Scorecard failed (`errors`).

### Summary

| Field | Content |
|---|---|
| `repositories_active` | Active repositories |
| `repositories_scanned` | Active repositories with an overall score |
| `average_score`, `median_score` | Mean and median of the overall scores, one decimal; `null` without scanned repositories |
| `checks_passed`, `checks_failed`, `checks_na` | Results per verdict |
| `repositories_with_findings` | Repositories with at least one `fail` |
| `repositories_with_errors` | Repositories with at least one `errors` row |

### History

The previous report is `scorecard-data.json` in the latest month folder of the reports directory **before** the month of this run, read exactly as the compliance report does it ([History](compliance_report_spec.md#history)): no git, the current month is never read, a file that is not valid JSON stops the run.

This run's entry is added for its month (`run_at`, UTC) and replaces an existing entry of the same month. The list is sorted by month. Entry: `month`, `average_score` (`null` for a run without data, shown as a gap) and `scores`, the overall score per scanned repository. Nothing else is read from the previous report.

---

## Run log

```
Report: OpenSSF Scorecard (OSPO-SC-2026-11)
Input: scorecard.json ok (90 results, 6 skipped, 0 errors), Scorecard v5.6.0
Scope: 5 active, 6 archived repositories; 5 scanned
Average score: 5.7 (previous 5.2), median 4.3
Checks: 36 passed, 25 failed, 29 not applicable; 5 repositories with findings
History: 2 months (previous report: OSPO-SC-2026-10)

JSON written to reports/2026-11/scorecard-data.json
HTML written to reports/2026-11/scorecard-report.html
```

`(previous …)` appears when the history has an earlier entry. `Warning:` lines appear when the input is missing or invalid and when `errors` is not empty. With `--debug`, one line per scanned repository follows the `Average score:` line: `  yukimi 9 (2 failed)`.

---

## JSON output

`<reports>/<YYYY-MM>/scorecard-data.json`. Keys in this order:

| Key | Content |
|---|---|
| `report_id` | `OSPO-SC-<YYYY-MM>`, month of `run_at` |
| `run_at`, `org`, `ospo_sha`, `run_url` | This run, as in the tool files |
| `previous_report` | `report_id` and `data_url` (link to the file that was read, on `main`) of the previous report, or `null` |
| `input` | `file`, `script`, `status`, `sha256` (of the file as read, `null` if missing); for `ok` the header fields `tool`, `run_at`, `ospo_sha`, `config_file`, `config_sha256`, `run_url`, `source`, `scorecard_version`, `scorecard_commit` and `counts` (`results`, `skipped`, `errors`, `repositories`); for `invalid` the `problems` |
| `scope` | `active` and `archived`, sorted |
| `summary` | See [Summary](#summary) |
| `history` | See [History](#history) |
| `repositories` | Scanned active repositories, sorted by name: `repo`, `commit`, `date`, `score` |
| `catalogue` | Copied from the tool file: all checks with `name`, `threshold` and `documentation` |
| `results` | Active repositories only: `repo`, `check`, `result`, `score`, `reason`, `details` |
| `skipped`, `errors` | Copied from the tool file (`repo`, `reason`; `repo`, `check`, `reason`) |

---

## HTML report

`scorecard-report.html` is the template `scripts/templates/scorecard_report.html` with `scorecard-data.json` embedded (`lib/report_html.js`), self-contained and with the same embedding and render guard as the [compliance report](compliance_report_spec.md#html-report). The page title is `OpenSSF Scorecard Report · <org> · <YYYY-MM>`. It uses the same design as the compliance report.

| Section | Content |
|---|---|
| Header | Report ID, status date, Scorecard version (linked to its commit), trend period, previous report, scope, workflow run (or "local run") |
| 1 Summary | Data-health box (input missing or invalid, `errors`), average overall score with change against the previous history entry and sparkline, repositories scanned, repositories with findings, failing checks, lowest score, bar chart of the overall score per repository |
| 2 Trend | Average overall score and repositories scanned over the last 6 months, one slot per month; a month without a report is a gap |
| 3 Repositories | Every repository with a score, a result or an error: overall score ("not scanned" without one), 6-month sparkline, change against the previous report ("new" without one), failing checks with score and threshold (and the number of errors), scanned commit. Sortable, filterable and paged (25, 50 or 100 rows); not scanned repositories sort last. Each row expands to every check with score, threshold, result, reason and detail lines (`scorecard_check:` decisions highlighted), failing checks first, plus its errors; a failing-check tag opens it. Printing shows every repository expanded |
| A Scope and method | Active, scanned, not scanned (with reason) and archived repositories; how score, overall score, pass/fail, not applicable and no data are decided, linked to the scorecard_check configuration and spec; the tool run (or "File missing" / "File invalid" with the problems); errors |

Printing expands every repository and shows all of them. Links to the ospo repository are pinned to `ospo_sha`; commits are shown with 7 characters.

---

## Make target

`make create_reports` runs this script after the compliance reports, with the same `ORG`, `JSON_DIR` and `REPORTS_DIR` (see [compliance_report_spec.md](compliance_report_spec.md#make-target)). If `scorecard_check` failed (e.g. the Scorecard CLI is not installed), `scorecard.json` is missing and the report shows "no data". The monthly workflow commits it with the rest of `reports/<YYYY-MM>/`.
