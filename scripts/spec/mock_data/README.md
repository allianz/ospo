# Mock data (temporary)

Fictitious JSON outputs for one weekly compliance run on 3 Nov 2026. They follow the format and rules in `../compliance_implementation_draft.md`. Not meant to be kept.

## Files

| File | Written by | Content |
|---|---|---|
| `lint_repos.json` | `lint_repos.js --json` | Repository inventory + per-repository lint checks |
| `license_scan.json` | `license_scan.js --json` | SBOM availability, license coverage (info), deny list (internal policy) |
| `archive_repos.json` | `archive_repos.js --json` | Only the archivals performed in this run, with notice date and archival date |
| `drift.json` | `create_repos.js --dry-run --json` | Planned changes (none) = no drift |
| `org_snapshot.json` | `org_snapshot.js` | Org settings, ruleset, security configurations, org SECURITY.md, advisories |
| `scorecard.json` | `scorecard_check.js` | Scorecard scores per repository with thresholds applied |
| `data.json` | `compliance_report.js` | Merged result: requirement statuses, findings register, summary, history. Input for the HTML report |

## The 11 repositories and what each one demonstrates

| Repository | Demonstrates |
|---|---|
| `pricing-engine` | Fully compliant, releasing, signed release assets |
| `insurance-rule-dsl` | Missing CONTRIBUTING (GV.01); low Code-Review (QA.06); unsigned releases for 112 days → **BR.03 Not met** (overdue) |
| `quote-calculator-demo` | Unapproved license WTFPL (LE.01); denied dependency license (internal policy, not in the TR findings) |
| `pdf-render-service` | `security: custom` + `branch-protection: custom` (custom checks apply); no DEVELOPMENT.md (BR.01, QA.04); CI-Tests 2 (QA.04); release without notes (BR.04) |
| `design-guidelines` | Topic `docs` → BR.01 and QA.04 not applicable; Scorecard CI-Tests not applicable |
| `mobile-sdk-ios` | Objective-C 26% → QA.05 applies (passes via the "Memory safety" section, fuzzing is info only); version going backwards in major line 3 (BR.02) |
| `pricing-sandbox` | New repository: dependency graph disabled (QA.01, LE.02); no DEVELOPMENT.md; no pull requests yet → Scorecard inconclusive = `na` |
| `claims-event-schemas` | Issues disabled (QA.03) → all its findings go to the OSPO instead of an issue; a user with direct access (GV.02) |
| `kafka-schema-tools` | Inactive with an open notice. Not visible in `archive_repos.json`: open notices are not needed for any check |
| `legacy-xml-mapper` | Archived by `archive_repos` in this run, 60 days after the notice (DE.01 pass); no license → reported `info_only`, no status impact |
| `old-batch-tools` | Archived manually between the runs of 13 and 20 Oct. Not in any `archive_repos` output, so `compliance_report` derives the DE.01 failure (`tool: compliance_report` in `data.json`) |

`ng-aquila` is excluded from scope (deviation D-03) and appears only in `skipped` and `scope.excluded`.

## Real reference output (not mock data)

| File | Produced by | Content |
|---|---|---|
| `scorecard_cli_real_yukimi.json` | `scorecard --repo=github.com/allianz/yukimi --format=json --show-details` (CLI v5.6.0, run locally on 4 Nov 2026) | **Real, unmodified** Scorecard output. Reference for the input format that `scorecard_check` has to parse. Not part of the 3 Nov mock run. Identical to the API response below except `date` (local time of the run) and an extra `"metadata": null`. |
| `scorecard_api_real_yukimi.json` | `GET https://api.scorecard.dev/projects/github.com/allianz/yukimi` (fetched 4 Nov 2026; result dated 3 Nov 2026, published by the Scorecard Action in yukimi's `scorecard.yml`) | **Real** API response, only pretty-printed with `jq .`. Same schema as the CLI output, with `details` filled in. Scores and reasons are identical to a local CLI run on the same commit. |

On 4 Nov 2026, yukimi was the only active public allianz repository with results in the API. `ng-aquila`, `.github`, `geofeed` and `ospo` returned 404 because they do not run the Scorecard Action.

## Conventions used

- `result` is `pass`, `fail` or `na`. `info_only: true` results never affect a status.
- `repo: null` marks org-level checks (`org/*`, `drift/access`, `advisories/*`).
- Every `fail` that counts has `tracking`: either `issue` (with labels = the failing check IDs of that tool), or `ospo-notification`.
- Unpublished security advisories are redacted: the `unpublished` entries in `org_snapshot.json` carry no repository name.
- `data.json` → `findings[].since` is carried forward from the previous `data.json`. Age is computed against the run date.
