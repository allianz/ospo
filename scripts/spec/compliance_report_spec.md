# Spec: compliance_report implementation

## Motivation

The checking tools each write their results to a tool file in the common JSON format (see [Tool file format](#tool-file-format)). A report needs them combined: which requirement is met, how many repositories have findings, how the numbers develop month by month. This script aggregates the tool files of one run into one self-contained `<key>-data.json` per report configuration and renders the HTML report from it. Every number of the report can be traced to `data.json`.

## Scope

The script:

- reads the tool files named in the report configuration from one directory;
- validates them, merges their catalogues and results, and maps the checks to the requirements of the configuration;
- drops the repositories the configuration declares `out_of_scope`;
- adds a `fail` for every active repository a tool skipped through `excluded_repos`;
- computes the scope, the status and coverage of every requirement, and the summary;
- carries the trend history forward from the published report on `main`;
- reads the hand-written notes file;
- writes `<key>-data.json` and the HTML report `<key>-report.html` into the month folder of the reports directory (see [Output layout](#output-layout)).

Out of scope:

- Any call to GitHub or git. The script reads local files only.
- A Markdown report. Only the HTML report is rendered in this version.
- Running the tools. `make create_reports` runs them first (see [Make target](#make-target)).

## Tool file format

Every checking tool (`lint_repos`, `license_scan`, `archive_repos`) writes its results with `--json <file>` in one common format, built with `lib/json_output.js`:

```json
{
  "tool": "lint_repos",
  "run_at": "2026-11-03T02:00:00Z",
  "org": "allianz",
  "ospo_sha": "869f4bb",
  "config_file": "config/lint_repos.yaml",
  "config_sha256": "…",
  "run_url": "https://github.com/allianz/ospo/actions/runs/…",
  "issue_title": "Mandatory Repository Configuration",
  "results": [
    { "repo": "foo", "check": "lint/contributing", "name": "Contributing File",
      "result": "pass", "score": null,
      "reason": ".github/CONTRIBUTING.md found", "details": [] }
  ],
  "catalogue": {
    "lint/contributing": { "name": "Contributing File",
      "documentation": { "url": "https://github.com/allianz/ospo/blob/869f4bb/scripts/spec/lint_repos_spec.md#contributing-file",
                         "short": "A file CONTRIBUTING* exists in ., .github or docs.",
                         "fix": "Add CONTRIBUTING.md to .github/ describing how to propose changes." } }
  },
  "skipped": [ { "repo": "old-repo", "reason": "archived" } ],
  "errors": []
}
```

| Field | Content |
|---|---|
| `tool`, `run_at`, `org`, `ospo_sha`, `config_file`, `config_sha256`, `run_url` | The run: script name, time (UTC, seconds), organisation, commit of this repository, path and SHA-256 of the configuration, workflow run URL (`null` locally) |
| `issue_title` | Title of the tool's issue, copied from its configuration; `null` for a tool whose checks open no issue (`archive_repos`) |
| `results` | One row per repository and check, see below |
| `catalogue` | One entry per check the tool ran: `name`, `threshold` (only for scored checks) and `documentation` (`url`, `short`, optional `fix`) |
| `skipped` | Repositories without results (`repo`, `reason`), e.g. `archived` or `excluded_repos` |
| `errors` | Repository × check pairs the tool could not evaluate (`repo`, `check`, `reason`) |

A result row:

| Field | Content |
|---|---|
| `repo` | Repository name. Every check is per repository |
| `check` | Stable ID `<tool>/<check>`, e.g. `lint/contributing`. Key for the requirement mapping and the history |
| `name` | Readable name, e.g. "Contributing File". For tool output and issues only; the report uses the check ID |
| `result` | `pass`, `fail` or `na` (nothing to judge). A tool error is never `na`: it goes to `errors`, which the report treats as "no data" |
| `score` | 0–10 for a scored check (compared with the catalogue's `threshold`: `score >= threshold` passes), otherwise `null` |
| `reason` | One sentence for people, always filled (also for `pass` and `na`) |
| `details` | List of lines for people, `[]` if empty |

- **Text for people.** Nothing parses `reason` or `details`; the report computes only with `result` and `score`.
- **Catalogue.** Every check ID used in `results` is in the catalogue. `documentation.url` links the heading of the check in the tool's spec, pinned to `ospo_sha`, so an old report links the rule of its run. Each spec therefore has one heading per check, named like the check's `name`, with the rule (`short`) and a "How to fix" line (`fix`). `fix` is shown in the tool's issue.
- **Same shape.** `results`, `skipped` and `errors` are always present, `[]` if empty.

---

## CLI Interface

```
node scripts/compliance_report.js --org <org> --config <file> --dir <dir> [--reports <dir>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | Organisation of the run. A tool file of another organisation is invalid |
| `--config` | required | Report configuration, e.g. `config/report/compliance_report_allianz.yaml`. There is no default: one run per report |
| `--dir` | required | Directory with the tool files (`results/` in `make create_reports`). Only read |
| `--reports` | `reports/` of the repo | Reports directory. `data.json` and the HTML report are written to `<reports>/<YYYY-MM>/` |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes on GitHub |
| `--debug` | false | Also print every requirement with its status and counts |

Exit codes: `0` on success, also when tool files are missing or invalid ("no data" is a valid report). `1` on a missing flag, an invalid report configuration, a check ID defined by two tool files, an invalid `data.json` on `main`, or a fatal error.

No token is needed.

---

## Configuration File

One file per report. Every file name is set in the configuration; nothing is derived from the requirement set.

```yaml
key: allianz
framework:
  id: allianz-mandatory-repo-config
  title: Allianz Mandatory Repository Configuration
  version: "2026-11-10"
  url: https://cmp.allianz.net/spaces/ARGO/pages/2748785293/Mandatory+Repository+Configuration
  text_note: Summary of each requirement of the guideline page.
  chapters: { "2.1": Metadata, "2.2": Documentation, "2.3": Legal }
inputs:
  - { file: lint_repos.json, script: scripts/lint_repos.js }
notes: config/report/compliance_report_allianz_notes.md
out_of_scope:
  - { repo: .github, reason: "Organisation configuration, not a project" }
requirements:
  AZ.04:
    title: CONTRIBUTING present
    level: MUST
    chapter: "2.2"
    text:
      - { level: MUST, text: "The repository MUST contain a CONTRIBUTING.md …" }
    implementation: >-
      The linting bot looks for a CONTRIBUTING file …
    checks: [lint/contributing]
```

| Field | Required | Description |
|---|---|---|
| `key` | yes | `a-z`, `0-9` and `-`. Prefix of the output files (`allianz-data.json`, `allianz-report.html`) and of the report ID (`OSPO-CR-ALLIANZ-2026-11`). Unique across the configurations |
| `framework` | yes | The requirement set, copied into `data.json` unchanged. `chapters` names every chapter prefix used by a requirement ID |
| `inputs` | yes | Tool files in `--dir`: `file` and the `script` that writes it. The tool name of a file must be the basename of its script |
| `notes` | no | Notes file, relative to the repo root. Without it, `notes` is `null` |
| `out_of_scope` | no | Repositories this report does not cover, each with `repo` and `reason` (default `[]`). See [Scope](#scope) |
| `requirements` | yes | One entry per requirement ID (`<chapter>.<nn>`), in report order: `title`, `level` (`MUST`, `SHOULD`, `MAY`), `chapter` (optional, default the ID prefix; lets IDs like `AZ.01` be grouped by the sections of their guideline), `text` (list of clauses with `level` and `text`, default `[]`), `implementation` (plain text, default empty), `checks` (list of check IDs, `[]` for none), `implemented` (optional, default `true`; `false` marks a requirement that has no check yet and needs `checks: []`, see [Requirements](#requirements)) |

### Validation

- A missing field: `Config missing required field: <field> (in <file>)`.
- An invalid `key`, an input without `file` or `script`, `out_of_scope` that is not a list, an entry without `repo` or `reason`, a repository listed twice, a chapter (from the ID or the `chapter` field) that is not in `framework.chapters`, an invalid `level`, a missing `title`, `checks` that is not a list, `implemented` that is not `true` or `false`, or `implemented: false` with checks: an error naming the requirement and the file.

---

## Steps

### Read and validate

Every file in `inputs` is read from `--dir`. Its `inputs` entry has `status`:

- `missing`: the file does not exist.
- `invalid`: not valid JSON, or against the common format: a header field missing (`tool`, `run_at`, `org`, `ospo_sha`, `config_file`, `config_sha256`, `run_url`, `issue_title`), `tool` not the basename of `script`, `org` not `--org`, `catalogue` not an object, `results`, `skipped` or `errors` not a list, a result check not in the file's catalogue, a result other than `pass`, `fail` or `na`, or two results for the same repository and check. `problems` lists the reasons.
- `ok`: the file is used.

A missing or invalid file contributes nothing: its checks have no results, which the report shows as "no data".

### Scope

From the valid tool files only:

- **archived:** repositories listed under `skipped` with reason `archived` or `archived in this run` by any tool;
- **out of scope:** the repositories in `out_of_scope` of the configuration, with their reason; an archived repository is only listed as archived;
- **active:** every other repository that appears in a result, under `skipped` or in `errors`.

Results of archived and out-of-scope repositories are dropped, so they count nowhere. `out_of_scope` is the report's own decision and states its reason in the report. It differs from a tool's `excluded_repos`, which keeps the repository in scope and counts it as failing (see [Excluded repositories](#excluded-repositories)). A repository that `archive_repos` archives in this run may still have results from tools that ran before it.

### Merge

- **Only mapped checks.** `catalogue`, `results` and `errors` keep the checks that a requirement of the configuration maps. Tools write more checks for their own issues (e.g. `lint/description`, `archive/recent-activity`, `license/denied-licenses`); these stay out of `data.json`.
- **Catalogue:** each entry gets the defining `tool`, keeps `threshold` (scored checks) and `documentation` (`url`, `short`). `name` and `fix` are dropped. A check ID defined in two tool files stops the run.
- **Results:** concatenated in input order, each row with `repo`, `check` and `result`, plus `score` for scored checks (the catalogue entry has a `threshold`).
- **Skipped** and **errors:** concatenated, each row with `tool` first. Errors without a check are kept.

### Excluded repositories

For every active repository that a tool lists under `skipped` with reason `excluded_repos`, the script adds a `fail` result for each mapped check of that tool's catalogue (`score: null` for scored checks). A skipped repository therefore counts as failing. This is why the tool configurations say "Keep this empty".

### Requirements

For each active repository and requirement, the outcome over the requirement's checks is:

| Outcome | When |
|---|---|
| `failing` | at least one check is `fail` |
| `no_data` | no `fail`, but at least one check has no result (missing or invalid tool file, an `errors` row, or another skip reason such as `no push activity yet`) |
| `not_applicable` | every check is `na` |
| `passing` | otherwise: every check is `pass` or `na` |

`repositories` holds these counts plus `applicable` (= `passing` + `failing`). `coverage` is `passing / applicable` in percent with one decimal, `null` when nothing is applicable.

The status, first matching row:

| Status | When |
|---|---|
| `not-implemented` | `implemented: false`: no check exists for the requirement yet. Not counted, also not in `must_total` |
| `not-met` | a MUST requirement with `checks: []` |
| `not-assessed` | a SHOULD or MAY requirement with `checks: []` |
| `optional` | a MAY requirement with checks; reported for information, not counted |
| `met-findings` | at least one repository is `failing` |
| `no-data` | no repository is `passing` or `not_applicable`: none of the checks has data |
| `met` | otherwise, also when all repositories are `not_applicable` |

Requirements without checks have `repositories: null` and `coverage: null`. `implemented` itself is not written to `data.json`; the status `not-implemented` records it.

`not-met` and `not-implemented` differ in what they say: `not-met` states that no check can cover a MUST requirement, so the organisation does not meet it. `not-implemented` states that a check is planned but not built yet (Allianz report, e.g. AZ.10 license headers).

### Summary

Counted over the checks of the requirements with status `met`, `met-findings` or `no-data`, each repository × check result once (a check mapped to two requirements counts once):

| Field | Content |
|---|---|
| `checks_evaluated` | Results other than `na` |
| `checks_passed` | Results `pass` |
| `compliance_pct` | `checks_passed / checks_evaluated` in percent, one decimal; `null` without evaluated checks |
| `requirements_by_status` | Number of requirements per status, all seven statuses always present |
| `must_met`, `must_total` | MUST requirements with status `met` or `met-findings`, and all MUST requirements except `not-implemented` |
| `failing_repositories` | Active repositories that are `failing` in at least one counted requirement |

### History

The previous report is the `data.json` of this report in the latest month folder of the reports directory (`--reports`) **before** the month of this run: `reports/2026-10/allianz-data.json` for a run in November. Folders that are not a month (`YYYY-MM`) and other reports are ignored; a month folder without this report's file is skipped. The current month is never read: a rerun builds on the same previous month, and its own file is overwritten. Without such a file (first report), `previous_report` is `null` and the history starts empty. A file that is not valid JSON stops the run.

The script reads local files only, no git. In CI, the reports directory is the checkout of the report branch, which is created from `main`, so it holds the merged reports. Locally, the folder can be prepared by hand for testing.

This run's entry is added for its month (`run_at`, UTC) and replaces an existing entry of the same month. The list is sorted by month. Entry: `month`, `compliance_pct`, `failing_repositories`, and `coverage` per counted requirement. Nothing else is read from the previous report.

### Notes

The notes file named by `notes:`:

- exactly the headings `## Key messages` and `## Needs attention`, in this order;
- under each heading, bullets `- <text>`, one per line, and blank lines; an empty section is valid;
- inline Markdown only: `**bold**`, `` `code` ``, `[text](https://…)`. Any other `*`, `` ` ``, `[`, `]`, `<`, `>`, an image or `_emphasis_` is invalid. Underscores inside words (`snake_case`) are plain text.

Missing file: `notes: null`. Invalid file: `notes: null` and an `errors` row `{ tool: "compliance_report", repo: null, check: null, reason: "Notes file … is invalid: line N: …" }`.

---

## Run log

```
Report: Allianz Mandatory Repository Configuration (OSPO-CR-ALLIANZ-2026-11)
Inputs:
  lint_repos.json        ok (130 results, 3 skipped, 0 errors)
Scope: 10 active, 2 archived, 1 out of scope repositories
Requirements: 4 met, 7 met-findings, 0 not-met, 0 no-data, 0 not-assessed, 2 not-implemented, 0 optional
Compliance: 80.5% (95 of 118 checks passed), 7 repositories with findings
History: 5 months (previous report: OSPO-CR-ALLIANZ-2026-10)

JSON written to reports/2026-11/allianz-data.json
HTML written to reports/2026-11/allianz-report.html
```

`Warning:` lines appear when an input is missing or invalid, when `errors` is not empty, and for a mapped check that no tool file defines although all inputs are `ok` (most likely a typo in the mapping). With `--debug`, one line per requirement follows the `Requirements:` line: `GV.01 met-findings 70% (7/10, na 0, no data 0)`.

---

## JSON output

`<reports>/<YYYY-MM>/<key>-data.json`. Keys in this order:

| Key | Content |
|---|---|
| `report_id` | `OSPO-CR-<KEY>-<YYYY-MM>`, month of `run_at` |
| `run_at`, `org`, `ospo_sha`, `run_url` | This run, as in the tool files |
| `report_config`, `config_sha256` | Path of the report configuration relative to the repo root, and its SHA-256 |
| `framework` | Copied from the configuration |
| `previous_report` | `report_id` and `data_url` (link to the `data.json` that was read, on `main`) of the previous report, or `null` |
| `inputs` | One entry per configured file: `file`, `script`, `status`, `sha256` (of the file as read, `null` if missing); for `ok` the header fields `tool`, `run_at`, `ospo_sha`, `config_file`, `config_sha256`, `run_url`, `issue_title`, and `counts` (`results`, `skipped`, `errors`); for `invalid` the `problems` |
| `scope` | `active` and `archived`, sorted; `out_of_scope` as `{ repo, reason }`, sorted by `repo` |
| `requirements` | One entry per requirement in configuration order: `id`, `chapter`, `level`, `title`, `text`, `implementation`, `checks`, `status`, `repositories`, `coverage` |
| `summary` | See [Summary](#summary) |
| `notes` | `file`, `sha256`, `key_messages`, `needs_attention`, or `null` |
| `history` | See [History](#history) |
| `catalogue`, `results`, `skipped`, `errors` | Merged, see [Merge](#merge) |

`data.json` stores no derived lists such as findings per repository. `summary` and the requirement counts can be recomputed from `results`, `scope` and `requirements[].checks` alone (`not-implemented` is taken from the status, as the configuration declares it); a test does this.

---

## Output layout

```
reports/                  committed by pull request, never emptied
  README.md               index of all months (reports_index_spec.md), regenerated by make create_reports
  2026-11/
    allianz-data.json
    allianz-report.html
  2026-12/
    …
results/                  tool files of the run (gitignored), emptied by make create_reports
```

- The month folder is the month of `run_at` (UTC), `YYYY-MM`, so the folders sort by name.
- A rerun in the same month overwrites that month's files of the same report. Other months and other reports are not touched.
- The tool files are not committed. `data.json` pins each one by `sha256` in `inputs`.

---

## HTML report

`<key>-report.html` is the template `scripts/templates/compliance_report.html` with `data.json` embedded (`lib/report_html.js`):

- **Self-contained.** One file, no external resources. The page renders itself in the browser from the embedded `<script type="application/json" id="data.json">` and reads nothing else. It needs JavaScript; without it, a `<noscript>` note is shown.
- **Embedding.** `JSON.stringify(data)` with every `<` written as `\u003c`, so no text in the data can close the script tag. The page title is `<framework.title> Compliance Report · <org> · <YYYY-MM>`, HTML-escaped. The template must contain each placeholder (`__DATA_JSON__`, `__TITLE__`) exactly once.
- **Render guard.** When rendering succeeds, `<html data-render="ok">` is set. When it fails, the error is shown in a red box at the top and `data-render="error"` is set, so a broken report is never blank. Headless checks use this attribute.

Sections, all computed from `data.json`:

| Section | Content |
|---|---|
| Header | Report ID, status date, trend period, previous report (or "none (first report)"), scope, workflow run (or "local run") |
| 1 Management summary | Data-health box (missing or invalid inputs, `errors`), overall compliance with change against the previous history entry, MUST requirements met, active repositories with findings, requirements with findings, status bars per level, Key messages and Needs attention from `notes` |
| 2 Requirement status | One row per requirement by chapter: level, status, coverage ("No data" or "Not applicable" when nothing is applicable), 6-month sparkline. Expanding a row shows the clauses, implementation, the checks with rule, threshold and source script, and the number of repositories without data |
| 3 Trends | Overall compliance and active repositories with findings over the last 6 months, one slot per month; a month without a report is a gap |
| 4 Findings | Failing repositories per requirement, active repositories by number of failed requirements |
| 5 Repositories | Every repository with its failed requirements, failing checks (score and threshold for scored checks), checks passed, and links to the open issue of each tool that has one. Sortable and filterable; printing shows every repository |
| A Scope and method | Active, archived and out-of-scope repositories (with the reason), active repositories excluded by a tool (counted as failing) or skipped for another reason (no data), status definitions, one row per tool file (or "File missing" / "File invalid" with the problems) |

Links to the source scripts are pinned to `ospo_sha`; commits are shown with 7 characters.

---

## Make target

`make create_reports` runs `lint_repos` and `license_scan` with `--json` into a fresh `results/` (the tool files the Allianz report reads), then this script once per `config/report/compliance_report_*.yaml`, which writes into `reports/<YYYY-MM>/`, and finally [`reports_index.js`](reports_index_spec.md), which regenerates `reports/README.md`:

| Variable | Default | Meaning |
|---|---|---|
| `ORG` | `allianz` | Organisation |
| `CONFIG_DIR` | `config` | Tool configurations (`scripts/test-config` for the sandbox) |
| `JSON_DIR` | `results` | Directory of the tool files, emptied first (gitignored). The same directory the `test_*` targets write to |
| `REPORTS_DIR` | `reports` | Reports directory (`--reports`), never emptied |

Both always run with `--dry-run`: a report run never opens or closes issues. There is no variable to switch this off; the tools act on GitHub through their own workflows. A report configuration that reads other tool files needs their tools added to the target.

A failing tool does not stop the target: it leaves no file, and the report shows "no data" for its checks. Because the directory starts empty, no file of an earlier run is ever used.
