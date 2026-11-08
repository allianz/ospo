# Spec: community_report implementation

## Motivation

[`community_metrics`](community_metrics_spec.md) collects the community numbers of the previous month: per repository and for the organisation, counts only. This script turns them into the monthly community report for the business owner: the headline numbers and their growth, the highlights of the month, and the stats and trends of every project, small ones included. One self-contained `community-data.json` and the HTML report `community-report.html` rendered from it. Every number of the report can be traced to `community-data.json`.

The report is **positive**: growth and milestones, no findings, no rankings, no badges. A number that went down is shown neutral (▼, grey), not red.

## Scope

The script:

- reads `community.json` from one directory and validates it;
- carries the history forward from the previous month's report;
- computes growth, milestones and highlights;
- writes `community-data.json` and `community-report.html` into the month folder of the reports directory, next to the other reports.

Out of scope:

- Any call to GitHub or git. The script reads local files only. `make create_reports` runs `community_metrics` first.
- A Markdown report.

## CLI Interface

```
node scripts/community_report.js --org <org> --dir <dir> [--reports <dir>] [--debug]
```

The same flags, exit codes and input handling as [`scorecard_report.js`](scorecard_report_spec.md#cli-interface), with `community.json` instead of `scorecard.json`: exit code `0` also when `community.json` is missing or invalid ("no data" is a valid report).

## Read and validate

`<dir>/community.json` gets an `input` entry with `status`:

- `ok`: valid.
- `missing`: no file.
- `invalid`: not valid JSON, against the common format (the same checks as the compliance report, see [compliance_report_spec.md](compliance_report_spec.md#read-and-validate), with `tool` `community_metrics`), or a `period` without `month` (`YYYY-MM`), `from` and `to`, `levels.milestones` that is not an object, `totals` that is not an object, `releases` or `repositories` that is not a list, an entry without `repo`, or a repository listed twice. `problems` lists the reasons.

A missing or invalid file gives an empty report: the period is the month before the run, all totals `null`, no repositories, milestones or highlights. It adds **no** history entry, so next month's report compares with the last month that has data.

## History

The previous report is `community-data.json` in the latest month folder of the reports directory **before** the month of this run, read as in the [compliance report](compliance_report_spec.md#history). This run's entry is added for its month (replacing an entry of the same month) and the list is sorted. All entries are kept; the report shows the last 6 months.

Entry: `month` (of the run), `period` (the month of the numbers), `totals` (traffic without its dates), per repository `traffic` (`views`, `visitors`, `clones`, `cloners`, or `null`), `stars`, `forks`, `contributors`, `prs_merged`, `commits`, `releases_total`, `release_downloads`, and `milestones` (the ids the organisation holds).

## Growth

`growth` holds per headline number (`stars`, `visitors`, `cloners`, `views`, `clones`, `contributors`, `external_contributors`, `public_projects`, `prs_merged`, `releases`) the `value` of this period, `previous` (the entry of the month before) and `six_months_ago` (the entry of the period 6 months before). The months are exact: without the entry of that month the value is `null` and the change is shown as `–`. Month values (merged PRs, releases) compare the month; totals (stars, contributors) compare the totals. Traffic compares the 14-day values of the runs; it is never extrapolated to a month.

## Milestones

A milestone is `<metric>-<level>` for every level of `levels.milestones`, checked against the totals (`visitors`: unique visitors of the last 14 days, `contributors`: internal plus external). The organisation **holds** every level its current total reaches; a milestone is **new** when it was not held in the latest earlier history entry. In the first report nothing is new.

## Highlights

Sentences generated from this month's data, in this order (`kind`, `icon`, `repo` where it is about one project, `text`):

1. `milestone` 🎉: new milestones, only the highest new level per metric: "The organisation passed 2,500 stars." (`unique visitors in 14 days`, `stars`, `public projects`, `contributors`, `external contributors`).
2. `new` 🆕: new projects: "*project* was published: *description*." (or "was published." without a description).
3. `first_external` 🌍: a project whose external contributors went from 0 in the latest earlier entry to at least 1: "*project* got its first external contributor." Few external contributions are expected, so each one is a highlight.
4. `welcome` 👋: first-time contributors of the organisation: "11 people made their first contribution, 2 of them from outside Allianz." (or "1 person from outside Allianz made their first contribution.", "3 people made their first contribution.").
5. `releases` 🚀: "15 releases in October."; the report lists them from `releases`.

## Run log

```
Report: Open Source Community (OSPO-CM-2026-11)
Input: community.json ok (38 repositories, 4 skipped, 1 error)
Period: October 2026
Stars: 5,138 (previous 4,848) · Unique visitors: 4,145 (previous 4,028) · Contributors: 275 (previous 264)
Milestones: 9 held, 1 new: stars-5000
Highlights: 5
History: 7 months (previous report: OSPO-CM-2026-10)

JSON written to reports/2026-11/community-data.json
HTML written to reports/2026-11/community-report.html
```

`(previous …)` appears when the month before has an entry. `Warning:` lines appear when the input is missing or invalid and when `errors` is not empty. With `--debug`, one line per highlight follows the `Highlights:` line: `  🆕 chatbot-starter was published: Starter kit for conversational assistants.`

## JSON output

`<reports>/<YYYY-MM>/community-data.json`. Keys in this order:

| Key | Content |
|---|---|
| `report_id` | `OSPO-CM-<YYYY-MM>` (month of the run) |
| `run_at`, `org`, `ospo_sha`, `run_url` | Of this run |
| `previous_report` | `report_id` and `data_url` of the previous report, or `null` |
| `input` | `file`, `script`, `status`, `sha256` (of the file as read, `null` if missing); for `ok` the header fields `tool`, `run_at`, `ospo_sha`, `config_file`, `config_sha256`, `run_url` and `counts` (`repositories`, `skipped`, `errors`); for `invalid` the `problems` |
| `period` | `month`, `from`, `to` |
| `levels` | From `community.json` (`milestones`, `active_within`) |
| `totals` | From `community.json` |
| `growth` | See [Growth](#growth) |
| `repositories` | From `community.json`, sorted by name |
| `milestones`, `new_milestones` | See [Milestones](#milestones) |
| `highlights` | See [Highlights](#highlights) |
| `releases` | The releases of the period: `repo`, `tag`, `date` |
| `history` | See [History](#history) |
| `skipped` | `repo`, `reason` |
| `errors` | `repo`, `metric`, `reason` |

## HTML report

`community-report.html` is the template `scripts/templates/community_report.html` with `community-data.json` embedded (`lib/report_html.js`), self-contained and with the same embedding and render guard as the [compliance report](compliance_report_spec.md#html-report). The page title is `Open Source Community Report · <org> · <YYYY-MM>`.

| Section | Content |
|---|---|
| Header | Report ID, period, status date, trend period, previous report, scope, workflow run |
| 1 At a glance | Lead sentence (visitors and cloners of the last 14 days and their growth in 6 months, first external contributions and releases of the month, star growth); red box only when `community.json` is missing or invalid, a neutral note when single metrics are in `errors` (shown as "no data"); hero tile *Stars* (note: public, new and active projects, forks); tiles *Unique visitors* and *Unique cloners* (last 14 days, with views and clones), *External contributors* (all-time, new this month), *Releases* (month). Each with change vs the month before and vs 6 months before, and a 6-month sparkline |
| 2 Highlights | The highlight sentences ("Nothing new this month." without any) |
| 3 Growth | 6-month charts: stars and unique visitors (lines; visitors one point per monthly run, the 14-day value, views in the tooltip), contributors all-time, counted once across projects, and merged PRs per month (stacked columns internal / external). Each with a data table |
| 4 Projects | One row per project: name and description (expandable); stats as chips: 🆕 New project, 👥 contributors (all-time, external), 🚀 releases, 🍴 forks, 🔥 Active, each with its growth of the month in green where it grew; stars with the growth of the month. Growth "this month" compares with the history entry of the month before. Sort (name (default), most stars, most new stars, most contributors), filter by name, expand all; 25, 50 or 100 rows per page (default 25). An expanded row shows three boxes, each with its period, longest first: *All-time* (stars, forks, contributors, releases, release downloads, publication date), *Last month* (new and active contributors, commits, PRs merged, issues opened / closed, releases with their tags) and *Last 14 days* (the traffic window: views, unique visitors, clones, unique cloners); and three 6-month trends of the project: stars and unique visitors (lines, starting at publication) and merged PRs per month (internal / external). Printing shows every project expanded |
| A Scope and method | Projects in scope and not included, definitions (period, internal / external, bots, contributors, traffic, active), missing data (`errors`) |

Internal and external use categorical slots 1 and 2 (blue external, orange internal), validated in light and dark mode, always with a legend and data table. A metric that is `null` is shown as `–` or "no data"; a chart without any value shows "No data.".

## Make target

`make create_reports` runs this script after the Scorecard report, with the same `ORG`, `JSON_DIR` and `REPORTS_DIR` (see [compliance_report_spec.md](compliance_report_spec.md#make-target)). The monthly workflow commits it with the rest of `reports/<YYYY-MM>/`.
