# Mock data (temporary)

Fictitious JSON outputs for one weekly compliance run on 3 Nov 2026. They follow the format and rules in `../compliance_implementation_draft.md`. Not meant to be kept.

## Files

| File | Written by | Content |
|---|---|---|
| `lint_repos.json` | `lint_repos.js --json` | Per-repository lint checks. Archived repositories only appear under `skipped` |
| `license_scan.json` | `license_scan.js --json` | SBOM availability, license coverage (not mapped), deny list (internal policy, not mapped) |
| `archive_repos.json` | `archive_repos.js --json` | Only the archivals performed in this run; notice and archival dates in the `archivals` block |
| `drift.json` | `create_repos.js --dry-run --json` | Planned changes (none) = no drift |
| `org_check.json` | `org_check.js` | Org-level checks, one per expected value: org settings, ruleset, security configuration, org SECURITY.md, advisories. Actual values are in `details`; no raw API data |
| `scorecard.json` | `scorecard_check.js` | Scorecard CLI results per repository, converted to the common format with thresholds applied |
| `data.json` | `compliance_report.js` | Aggregation of all files above (draft 1.10), reduced to what the report shows: shown header fields in `inputs`; `catalogue` without `name`; `results` rows with `repo`, `check`, `result`, plus `score` (scored checks) or `reason` (org-level checks); `skipped` and `errors` with `tool`. Plus `fail` results for active repositories a tool skipped, requirement statuses, summary, history. The only input for the HTML report. Created by hand from the files above |

## The 12 repositories and what each one demonstrates

| Repository | Demonstrates |
|---|---|
| `pricing-engine` | Fully compliant, releasing, signed release assets |
| `insurance-rule-dsl` | Missing CONTRIBUTING (GV.01); low Code-Review (QA.06); unsigned releases (BR.03) |
| `quote-calculator-demo` | Unapproved license WTFPL (LE.01); denied dependency license (internal policy, not in the TR findings) |
| `pdf-render-service` | `security: custom` + `branch-protection: custom` (custom checks apply); no DEVELOPMENT.md (BR.01, QA.04); CI-Tests 2 (QA.04); release without notes (BR.04) |
| `design-guidelines` | Topic `docs` → BR.01 and QA.04 not applicable; Scorecard CI-Tests not applicable |
| `mobile-sdk-ios` | Objective-C 26% → QA.05 applies (passes via the "Memory safety" section; Scorecard fuzzing is not mapped); version going backwards in major line 3 (BR.02) |
| `pricing-sandbox` | New repository: no SBOM, request returns 404 (QA.01, LE.02); no DEVELOPMENT.md; no pull requests yet → Scorecard inconclusive = `na` |
| `claims-event-schemas` | Issues disabled (QA.03); a user with direct access (GV.02) |
| `kafka-schema-tools` | Inactive with an open notice. Not visible in `archive_repos.json`: open notices are not needed for any check |
| `legacy-xml-mapper` | Archived by `archive_repos` in this run, 60 days after the notice (DE.01 pass); listed as `skipped` (archived) in `lint_repos.json` and `license_scan.json`, so its missing license is not reported |
| `ng-aquila` | Excluded from the tools (`excluded_repos`), but counted as failing all of their mapped checks (see below) |
| `old-batch-tools` | Archived manually between the runs of 13 and 20 Oct. Not in any `archive_repos` output, so `compliance_report` derives the DE.01 failure (`report/archived-outside-process`, a check of `compliance_report` itself, only in `data.json`) |

`ng-aquila` is in `excluded_repos` (license under legal review). `lint_repos`, `license_scan` and `scorecard_check` skip it, so it has no tool results and appears in their `skipped`. It is still active and in scope: `compliance_report` adds a `fail` result to `data.json` for every mapped per-repository check of each tool that skipped it (20 rows), so it fails every requirement with per-repository checks. The skip reason is shown in section A of the report.

There are no deviations. BR.06 has no check because builds cannot be verified as reproducible at portfolio scale. It has status `not-assessed` and is not counted. BR.05 has no check either, but it is `met` by construction (`basis`).

## Real reference output (not mock data)

| File | Produced by | Content |
|---|---|---|
| `scorecard_cli_real_yukimi.json` | `scorecard --repo=github.com/allianz/yukimi --format=json --show-details` (CLI v5.6.0, run locally on 4 Nov 2026) | **Real, unmodified** Scorecard output. Reference for the input format that `scorecard_check` has to parse. Not part of the 3 Nov mock run. Identical to the API response below except `date` (local time of the run) and an extra `"metadata": null`. |
| `scorecard_api_real_yukimi.json` | `GET https://api.scorecard.dev/projects/github.com/allianz/yukimi` (fetched 4 Nov 2026; result dated 3 Nov 2026, published by the Scorecard Action in yukimi's `scorecard.yml`) | **Real** API response, only pretty-printed with `jq .`. Same schema as the CLI output, with `details` filled in. Scores and reasons are identical to a local CLI run on the same commit. |

On 4 Nov 2026, yukimi was the only active public allianz repository with results in the API. `ng-aquila`, `.github`, `geofeed` and `ospo` returned 404 because they do not run the Scorecard Action.

## Conventions used

- In the tool files, every result has `repo`, `check`, `name`, `result` (`pass`, `fail`, `na`), `score` (Scorecard 0–10, otherwise `null`), `reason` (always filled) and `details` (list, Scorecard style). See section 1.6 of the draft. `data.json` keeps less, see above.
- Checks that are not mapped in `data.json` → `requirements` (license coverage, fuzzing, migration path, deny list) never affect a status.
- `repo: null` marks org-level checks (`org/*`, `drift/access`, `advisories/*`).
- Every file has a `catalogue` (`name`, `documentation.url`, `documentation.short`, `documentation.fix`); `data.json` → `catalogue` merges them, adds the defining `tool`, drops `name`, and keeps `fix` only for org-level checks and `report/*`. Scorecard checks have no `fix`. The OSPO URLs point to spec headings that do not exist yet; the Scorecard URLs are real.
- Data the report computes with is in a header block (`archivals`, `planned_changes`), never in `reason` or `details`.
- Results carry no `tracking`. Each tool keeps one issue per repository, but the report does not read issues; it only links to a live GitHub search by check label. Labels on that issue (= the failing check IDs) exist on GitHub only.
- Unpublished security advisories are redacted: their `details` lines in `org_check.json` carry no repository name.
- `data.json` stores no `findings` list. A repository has a finding for a requirement if it fails at least one applicable check of it; the report derives this from `results` and `requirements` and counts repositories, never failing checks. Findings carry no age or "failing since" date. From the previous `data.json`, only `history`, `archivals` and `scope.active` (for DE.01) are read. `history` holds overall compliance, active repositories with findings and, per requirement, `coverage` (share of applicable repositories that pass) for each weekly run. `pricing-sandbox` is new in the run of 3 Nov, so earlier runs have one applicable repository less where it applies; DE.01 has no value before the first archival. A finding's history is on GitHub, in the live issues. The `failing_repositories` values of the runs before 3 Nov are made up.
- `data.json` → `requirements[]` has one assessment per requirement, at the requirement's own level (no `parts`). Weaker clauses (SHOULD in GV.01 and VM.01, MAY in BR.03) are not assessed in this version.
