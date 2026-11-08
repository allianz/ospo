# DRAFT: BSI TR-03185 Chapter 2 implementation plan

Temporary working document, not meant to be kept. It lists every requirement of BSI TR-03185 v1.1.1 Chapter 2 and how it will be implemented and verified. Items marked **(verify)** are assumptions about GitHub or Scorecard behaviour that must be confirmed before implementation. Each requirement heading in Part 2 shows its implementation status: ✅ **Done**, all its checks are implemented and written to the tool's JSON file (`--json`); ⬜ **Open**, at least one check is still to be built; ➖ **Not assessed**, the requirement has no check (1.7).

---

## Part 1: Shared rules

Every requirement entry in Part 2 uses these rules. If an entry seems to contradict them, the rules win and the entry needs fixing.

### 1.1 Verification types

Every check has exactly one type:

| Type | When to use | What proves it |
|---|---|---|
| **Exact check** | Can change per repository, and the condition can be tested precisely | A per-repository check with a clear pass/fail |
| **Structural check** | Can change per repository, but only the form can be tested, not the content | A per-repository check, plus a "Limits of the check" note on the card |
| **By construction** | GitHub guarantees it; there is nothing to check | A check of the tool `by_construction` (1.5): always `pass`, one per active repository. Not a test; its rule says so |
| **Not verifiable** | No practical way to verify (SHOULD or MAY only) | Nothing. The requirement has status "Not assessed" and is not counted |

Rule: a MUST can never rely on **Not verifiable**. Central settings (org settings, ruleset, security configuration) are not a check type: they are described in the implementation text, and their effect is measured per repository where a check exists (e.g. GV.02).

### 1.2 Scope and applicability

- **In scope:** all active (not archived) repositories of the organisation. A repository in a tool's `excluded_repos` stays in scope: the tool skips it and lists it under `skipped`, and `compliance_report` counts it as failing every mapped per-repository check of that tool (see 1.10 step 4).
- **Out of scope by the report:** a report configuration may list repositories it does not cover in `out_of_scope`, each with a reason (e.g. `.github`, the organisation configuration, in the Allianz report). They are dropped like archived repositories and shown with the reason in the report.
- **Archived repositories:** the checking tools list them under `skipped` (reason `archived`) and write no results for them. They are out of scope, so no check has results for them.
- **Not applicable by topic:** repositories tagged `docs` or `template` have no software to build or test. QA.04 does not apply to them.
- **Releasing repositories:** repositories with at least one GitHub release in the last 12 months. BR.02–BR.04 only apply to these.
- **Not applicable by data:** when a check has no data to judge (e.g. Scorecard "inconclusive" because there were no changes), the result is `na`, not `pass`. A tool error is never `na`: it goes to `errors`, which the report treats as "no data".

### 1.3 Scripts and their roles

Every checking script works the same way: it **runs its checks, owns its issues, and writes a JSON result**. The report script only reads JSON files. It never changes anything on GitHub.

| Script | Status | Role |
|---|---|---|
| `create_repos.js` | exists | Preventive: provisions repositories, teams, security configuration, ruleset targets. Not part of the compliance run. |
| `lint_repos.js` | exists | Per-repository checks on repository data and the cloned content |
| `license_scan.js` | exists, extend | Dependency licenses from the SBOM. SBOM availability itself is by construction (QA.01) |
| `archive_repos.js` | exists, extend | Inactivity notices and archival |
| `by_construction.js` | exists | Writes the `by-construction` checks (1.5): one `pass` per check and active repository. Tests nothing. No issues. |
| `advisories_check.js` | exists | Checks the published security advisories of every repository (VM.02). Writes the JSON file only. No issues, no writes to GitHub. |
| `releases_check.js` | exists | Checks the GitHub releases of every repository: version identifiers (BR.02) and release notes (BR.04). Writes the JSON file only. No issues, no writes to GitHub. |
| `scorecard_check.js` | exists | Runs the Scorecard CLI per repository, converts its output to the common format, applies thresholds and applicability (e.g. languages for fuzzing, QA.05; see 1.9). Writes all Scorecard checks, not only the mapped ones, for the Scorecard report ([`scorecard_report.js`](scorecard_report_spec.md)). Writes the JSON file only. No issues, no writes to GitHub. |
| `compliance_report.js` | exists ([spec](compliance_report_spec.md)); Markdown open | Runs once per report configuration (1.8). Aggregates all tool files into one self-contained `data.json` per report (see 1.10): merges results, maps checks to requirements, computes statuses. Renders the HTML report from `data.json` only; Markdown later |

### 1.4 Monthly workflow

One workflow, `.github/workflows/compliance_report.yaml`, produces the reports. It runs on the 1st of every month at 03:00 UTC (scheduled), by manual dispatch, and when a notes file changes in the report PR. It runs all tools one after another in one job. Each tool writes its JSON file into a fresh local directory `results/`; then `compliance_report` aggregates them, and the run commits the result to the report PR:

```
lint_repos --json               → results/lint_repos.json
license_scan --json             → results/license_scan.json
archive_repos --json            → results/archive_repos.json
by_construction --json          → results/by_construction.json
advisories_check --json         → results/advisories_check.json
releases_check --json           → results/releases_check.json
scorecard_check --json          → results/scorecard.json
compliance_report --config config/compliance_report_bsi.yaml
                                ← results/*.json + latest earlier reports/<YYYY-MM>/bsi-data.json + its notes file
                                → reports/2026-11/bsi-data.json, reports/2026-11/bsi-report.html
compliance_report --config config/compliance_report_allianz.yaml
                                ← results/*.json + latest earlier reports/<YYYY-MM>/allianz-data.json + its notes file
                                → reports/2026-11/allianz-data.json, reports/2026-11/allianz-report.html
commit reports/2026-11/         → branch compliance-report, PR opened if none is open
```

- **Locally and in the workflow: `make create_reports`.** It runs the tool steps above into a fresh `results/` (each with a leading `-`, like `continue-on-error`) and then `compliance_report` once per `config/compliance_report_*.yaml`. It targets `allianz` and passes `--dry-run` to the tools that write to GitHub (`lint_repos`, `license_scan`, `archive_repos`). The workflow calls it unchanged, so the report run only reads: it opens no issues and archives nothing. With `--dry-run`, a repository that `archive_repos` would archive stays active and gets its results.
- **One run, several reports.** The tools run once; each report configuration (1.8) turns the same tool files into its own report. One commit holds all reports of the month, so they always rest on the same evidence. Each month has its own folder `reports/<YYYY-MM>/` (sorted by name); file names start with the report's `key`. The tool files stay in `results/` and are not committed: `data.json` pins each one by its `sha256` in `inputs`.
- **Published by pull request.** The run checks out the branch `compliance-report` if it exists and merges `main` into it (current scripts, merged reports; the notes edits of the open PR are kept), otherwise it creates the branch from `main`. A merge conflict fails the run. It commits the month folder `reports/<YYYY-MM>/` as the App's bot user and pushes with the GitHub App token; a push or PR with `GITHUB_TOKEN` would trigger no workflows. The tool files, the log and the reports are also uploaded as the run's artifact `compliance-report-<YYYY-MM>` (90 days), which is the easiest way to open the HTML. If no PR is open for the branch, it opens one. The OSPO reviews the PR, edits the notes files on the branch (1.8) and merges. The ruleset `ospo-managed` requires an approval: the App is the author, and an OSPO member approves. The merged commit on `main` is the published report. There is no release. The App needs `contents: write` and `pull_requests: write` on `ospo`, and the branch is deleted after the merge (repository setting "Automatically delete head branches"). Whether the ruleset requires signed commits or status checks that the App's commits cannot meet **(verify)**.
- **Why a pull request.** The default branch of `ospo` is protected by the ruleset like every other managed repository (GV.02). A direct push would need a bypass, and it would fail `ospo` on its own Code-Review and CI-Tests checks (QA.04, QA.06; see 1.9). The monthly merge also keeps the repository active: GitHub disables scheduled workflows in a public repository after 60 days without activity.
- **Editing the notes reruns everything.** `compliance_report.yaml` also runs on `pull_request` with `paths: config/compliance_report_*_notes.md`, only for the report PR of this repository (`github.head_ref == 'compliance-report'`). It runs all tools again, so the PR always shows the latest run. GitHub applies the path filter to the whole PR diff, so the workflow's own push would trigger it again: a guard step skips the run when the head commit changes only `reports/`.
- **Rerun:** dispatch the workflow. It adds a commit to the open PR, or opens a new PR if none is open. It merges `main` into the branch first, so it always uses the current scripts and reports.
- **Usually one report per month.** Every merge publishes a report. If two are merged in the same month, the later one replaces that month's entry in `history` (1.10 step 6).
- **The tools run in two places.** As part of `compliance_report.yaml`, once a month with `--json --dry-run`, for the report. And on their own schedules as today, for issues, notices and archiving (`lint_repos` twice a week, `license_scan` and `archive_repos` weekly), so project teams get feedback within days. The JSON-only tools (`by_construction`, `advisories_check`, `releases_check`, `scorecard_check`) open no issues and run only in `compliance_report.yaml`. Both runs use the same code and configuration; only the report run writes the JSON file, and only the scheduled runs write to GitHub.
- Each tool step runs with `continue-on-error`, and `compliance_report` always runs. A missing or invalid tool file means "no data", never "pass" (see 1.10). Because `results/` starts empty, a failed tool leaves no file, never last month's.
- `compliance_report` reads the `data.json` of its own report in the latest month folder before the current month, from the local `reports/` folder; it carries the trend history. The run's checkout of the report branch comes from `main`, so only merged reports enter the history (update the branch from `main` before a rerun if `main` changed). Each report has its own history. The checking scripts never read a previous run.
- The tool files are not committed; `data.json` pins them by `sha256`. The report itself is rendered from `data.json` only.

### 1.5 Check IDs and issues

- **Check IDs** have the form `<tool>/<check>`. The prefix names the tool that defines the check:

  | Prefix | Tool |
  |---|---|
  | `lint/` | `lint_repos` |
  | `license/` | `license_scan` |
  | `archive/` | `archive_repos` |
  | `advisories/` | `advisories_check` |
  | `releases/` | `releases_check` |
  | `scorecard/` | `scorecard_check` |
  | `by-construction/` | `by_construction`, see below |

- **`by-construction` checks test nothing.** The small script `by_construction` ([spec](by_construction_spec.md)) only lists the repositories of the organisation; its checks always pass. They stand for guarantees GitHub gives by design, e.g. `by-construction/source-archives`: the source archives of a release are generated by GitHub from the tag, so they always match the repository content (BR.05). Likewise `by-construction/sbom-available`: the dependency graph, and with it the SBOM, is always enabled for public repositories (LE.02, QA.01). It writes one `pass` per check and active repository into `results/by_construction.json`, like every other tool file, so that such a requirement has statuses, coverage and a card like every other requirement. The rule text of each check starts with "Not a test; always passes", and the report shows it under "How it is verified". It adds passing results to the compliance %.
- **Requirement mapping** exists in one place only: the report configuration (1.8), one per report. Each report maps the same check IDs to its own requirements. The scripts know nothing about requirement IDs.
- **JSON-only checks:** a check on something project teams have no influence on gets no issue: it writes results to the JSON file, but is not listed in the tool's issue and never opens one. Its results are evidence for the report and audits only, and the report shows them like every other check. This applies to `lint/public` (teams cannot change the visibility) and `lint/issues-enabled` (teams cannot disable Issues). A check can also be JSON only by decision: `lint/development` (BR.01) is something teams can fix, but it is tracked in the report only, without an issue (`json_only: true` in `config/lint_repos.yaml`). Likewise `releases/versioning` (BR.02) and `releases/release-notes` (BR.04): `releases_check` opens no issues at all. The same holds for all `scorecard/*` checks (GV.02, QA.04–QA.06, BR.03, VM.01): `scorecard_check` opens no issues; the Scorecard documentation linked in the catalogue explains remediation. The `by-construction` checks (e.g. `by-construction/sbom-available`: teams cannot remove the SBOM) open no issues anyway. The `fix` of a JSON-only check names the OSPO as the one who acts.
- **Issues:** each tool keeps one issue per repository, as `lint_repos` and `license_scan` do today. That issue lists all failing checks of that tool; it is the project team's to-do list for that tool. Issues are a convenience for the project teams. The report does not read them, and they do not affect any status: a team may close an issue without fixing the finding, and the tool opens it again on the next run. There are no labels.
- **Issue title:** each tool finds its own issue by its title (`issue_title` in its configuration, as today), and writes the title into its JSON header (1.6). The report uses it only for a link: next to a failing repository, one link per tool to that tool's open issue, a GitHub search such as `repo:allianz/foo is:issue is:open in:title "Mandatory Repository Configuration"`. There is no org-wide link per check or requirement: an issue lists all of a tool's findings in a repository, so it cannot be filtered by check. No link is shown for a tool without issues (`issue_title: null`) or for a repository the tool skipped, because the tool opened no issue there.
- **Security-sensitive results never become public issues.** If a check ever produces one, the tool opens no issue, and the public report shows counts only. No check in this version does.
- **Issues disabled or archived:** a tool cannot open an issue in a repository whose issues are switched off (QA.03) or that is archived. It skips the issue and logs a warning in its workflow run (`lint_repos` does this today). This is a tool problem, not a report concern; the finding is in the report either way.

### 1.6 Common JSON format

```json
{
  "tool": "lint_repos",
  "run_at": "2026-11-03T02:00:00Z",
  "org": "allianz",
  "ospo_sha": "869f4bb",
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

The result fields follow the Scorecard JSON (`name`, `score`, `reason`, `details`), so one parser reads both.

| Field | Content |
|---|---|
| `repo` | Repository name. Every check is per repository |
| `check` | Stable ID `<tool>/<check>`. Key for history and the requirement mapping |
| `name` | Readable name, e.g. "Contributing File" or Scorecard's "CI-Tests". For tool output and issues only; renaming it breaks nothing. `data.json` and the report use the check ID |
| `result` | `pass`, `fail` or `na` |
| `score` | 0–10 where the tool measures a score (Scorecard), otherwise `null`. Scorecard's `-1` becomes `null`. Compared with the check's `threshold` |
| `reason` | One sentence for people, always filled (also for `pass` and `na`), e.g. "Apache-2.0 is on the approved list" |
| `details` | List of lines for people, Scorecard style (`Warn: …`, `Info: …`), e.g. one line per file Scorecard found. Always a list, `[]` if empty. Never parsed |

- **Text for people.** Nothing parses `reason` or `details`; the report computes only with `result` and `score`. Raw API data that serves as evidence goes into `details`.
- **`catalogue`:** once per file, one entry per check the tool ran: `name`, `threshold` (only for scored checks) and `documentation` (`url`, `short`, optional `fix`), the same fields as Scorecard plus `fix`. `fix` is one sentence telling a project team what to do when the check fails, e.g. "Add CONTRIBUTING.md to .github/ …". It is written once per check, never per result, and is shown in the report next to "How it is verified" and in the tool's issue body. Checks the project team cannot fix (central settings, e.g. `lint/public`) say who acts. `scorecard_check` leaves `fix` out; the Scorecard `url` already explains remediation. `threshold` is the minimum score (0–10) to pass: `score >= threshold` → `pass`. The report shows it ("CI-Tests ≥ 8") and can verify that every non-`na` result agrees with it. Checks without a score have no threshold; their limit (e.g. 300 characters) is part of the rule in `documentation.short`. The URL is pinned to `ospo_sha`, so an old report links to the rule that was valid in that run. `scorecard_check` copies Scorecard's own documentation (pinned to the Scorecard commit). Every check ID used in `results` must be in the catalogue. `compliance_report` merges the catalogues into `data.json` → `catalogue`, adding the defining `tool` to each entry (see 1.10); the report uses it for "How it is verified". Each spec therefore needs one heading per check, named like the check's `name`, with the rule and a "How to fix" line that is the source of `fix`.
- **All checks are per repository.** Every result has a `repo`. Central settings are not checked; they are described in the implementation text (1.1).
- **Thresholds come from the tool's configuration** and are written once per check into the catalogue, never into the results. `config_sha256` pins the configuration of each run.
- **Whether a check counts** is decided only by the mapping in the report configuration (1.8). Tools write only checks that are mapped to a requirement; a tool's other checks (e.g. the deny list in `license_scan`, the required files in `lint_repos`) keep running and opening their issues, but stay out of the JSON. An unmapped check found in a tool file would not affect a status.
- **Exception: `scorecard_check` writes all Scorecard checks** listed in its `thresholds` (all 18 of Scorecard v5.6.0), with `score`, `reason` and `details`, also the 10 that no BSI requirement maps. They are kept for the Scorecard report ([`scorecard_report.js`](scorecard_report_spec.md)) next to the BSI report and do not affect any BSI status. For the same report, `scorecard.json` has an extra top-level list `repositories` (`repo`, scanned `commit`, `date`, overall `score`) and the header fields `source`, `scorecard_version` and `scorecard_commit`. `compliance_report` ignores `repositories`.
- **`issue_title`:** the title of the tool's issue (1.5), copied from its configuration. `null` for tools whose checks open no issue (`advisories_check`, `archive_repos`, `releases_check`, `scorecard_check`).
- `skipped` lists repositories without results (excluded, archived). `errors` lists repository × check pairs the tool could not evaluate. Both are always present, `[]` if empty, so every file has the same shape.

### 1.7 Status logic (computed by the report)

Each requirement is assessed once, at its own level: a MUST requirement on its MUST clause, a SHOULD requirement on its SHOULD clause. Weaker clauses inside a requirement (the SHOULD in GV.01 and VM.01, the MAY in BR.03) are not assessed in this version. A requirement has one list of checks and one coverage figure: a repository passes only if it passes every applicable check of the requirement.

- **Met:** all applicable repositories pass.
- **Met, with findings:** some applicable repositories fail.
- **Not met:** no check covers a MUST requirement.
- **Not assessed:** no check can verify a SHOULD or MAY requirement (e.g. BR.06, DE.02). It is shown in the report, but not counted in the summary.
- **Optional:** a MAY requirement with checks, reported for information. No requirement uses it in this version.

- **Findings count repositories.** A repository has a finding for a requirement if it fails at least one applicable check of that requirement. Every number in the report counts repositories (per requirement, or active repositories with at least one finding), never failing checks: which checks implement a requirement is an implementation detail, and one missing file can fail several checks. Failing checks are shown only as the explanation next to a repository.

- **Trend:** each report writes one entry per month to `data.json` → `history` (`month: "2026-11"`): the overall compliance, the number of active repositories with findings (`failing_repositories`) and, per requirement, the share of applicable repositories that pass (`coverage`). Each value is computed from that run's own results. Whether the run was early or late in the month does not matter. `history` keeps every month; nothing is made up for months without a report.
- **Trend display:** the report shows the last 6 months, one slot per month, ending with the current month. A month without a report has no point and no hover: the line continues through it, the bar chart has a gap. Before the first report the line is flat, so the first report already shows a horizontal line with one point and a single bar. Only the charts in section 3 have a hover with the values; the sparklines in the summary and per requirement have none.

- **No finding age:** the report does not compute how long a finding has been open. A "failing since" date would have to be carried forward from run to run, and it would silently reset on a missed run, a renamed repository or check, or a check that flaps. The tool's issue in a repository shows what fails now; its edit history shows earlier states at best, per repository, not per finding.

### 1.8 Report configurations

One configuration file per report. Every file and file name is set in the configuration; nothing is derived from the requirement set. Today there are two:

| Configuration | Report | Notes file |
|---|---|---|
| `config/compliance_report_bsi.yaml` | BSI TR-03185 Chapter 2 | `config/compliance_report_bsi_notes.md` |
| `config/compliance_report_allianz.yaml` | Allianz Mandatory Repository Configuration (the lint rules projects must follow; rules enforced by organisation settings are left out) | `config/compliance_report_allianz_notes.md` |

```yaml
# config/compliance_report_bsi.yaml
key: bsi                     # prefix of asset names (bsi-data.json, …) and of the report ID (OSPO-CR-BSI-2026-11)
framework:                   # requirement set, copied into data.json → framework
  id: bsi-tr-03185
  title: BSI TR-03185 Chapter 2
  version: 1.1.1
  url: https://www.bsi.bund.de/dok/TR-03185-en
  chapters: { GV: Governance, LE: Legal, QA: Quality, BR: Build and release, VM: Vulnerability management, DE: Decommissioning }

inputs:                      # tool files expected in results/ (see 1.10)
  - { file: lint_repos.json,    script: scripts/lint_repos.js }
  - { file: license_scan.json,  script: scripts/license_scan.js }
  - { file: archive_repos.json, script: scripts/archive_repos.js }
  - { file: by_construction.json, script: scripts/by_construction.js }
  - { file: advisories_check.json, script: scripts/advisories_check.js }
  - { file: releases_check.json, script: scripts/releases_check.js }
  - { file: scorecard.json,     script: scripts/scorecard_check.js }

notes: config/compliance_report_bsi_notes.md   # optional, any path; see below
out_of_scope:                # optional: repositories this report does not cover, with the reason (see 1.2)
  - { repo: .github, reason: "Organisation configuration, not a project" }

requirements:
  GV.01:
    title: How to contribute is documented
    level: MUST
    implementation: >
      Every repository must contain a contribution guide …
    checks: [lint/contributing]
  BR.06:
    checks: []               # not verifiable → "Not assessed"
```

- Every change to these files goes through a PR, which gives the audit trail.
- `key` must be unique across the configurations.

**Notes file.** "Key messages" and "Needs attention" in the report are written by hand, never generated: they say what the numbers cannot (causes, decisions, owners, dates). Each report has its own notes file, set by `notes:` in its configuration; without `notes:` the report has no commentary. The OSPO edits it in the report PR before merging (1.4), so the text is reviewed together with the run it is published with. It is kept apart from the configuration, so `config_sha256` still changes only when the mapping changes. The file is overwritten from month to month; each month's text is preserved in that month's `data.json` → `notes`.

```markdown
## Key messages

- **Release integrity is the weakest area.** Several releasing repositories do not sign their releases (BR.03).

## Needs attention

- **Decision: ng-aquila license review** (Legal, by 30 Nov 2026). Until it is done, `ng-aquila` fails most requirements.
```

- **No numbers.** The text is high level for management: what matters, why, next actions, decisions with owner and date. Percentages and counts are in the report next to the boxes; every edit of the notes reruns the tools (1.4), and the text carries over to the next month, so numbers in it would go stale.
- Exactly these two headings, each a list of bullets. Inline Markdown only: `**bold**`, `` `code` ``, `[text](https://…)`. Anything else makes the file invalid.
- No file, an empty section, or an invalid file: the box is hidden. An invalid file is also reported in the data-health banner (1.10).
- Text in the file is published as is. It must follow the same rule as issues: nothing security-sensitive (1.5).

### 1.9 Scorecard conversion (`scorecard_check`)

**Source:** the Scorecard CLI, `scorecard --repo=github.com/<org>/<repo> --format=json --show-details`, run for every in-scope repository in the compliance workflow, with a pinned version (`scorecard_version` in `config/scorecard_check.yaml`; the run fails on another version). Full rules: [`scorecard_check_spec.md`](scorecard_check_spec.md). The public API (`api.scorecard.dev`) only has results for repositories that run the Scorecard Action with `publish_results`; on 4 Nov 2026 that was 1 of 5 active allianz repositories. The CLI output is identical to the API response except `date` (local time) and an extra `metadata: null` (the real CLI output of allianz/yukimi is the test fixture `scripts/test/fixtures/scorecard_cli_real_yukimi.json`).

**Conversion per check** (match by `name`, not by position; the first matching row decides):

| Scorecard | Result |
|---|---|
| Branch-Protection on a `branch-protection: managed` repository (`config/create_repos.yaml`) | `na` (protected by the org ruleset `ospo-managed`, documented in GV.02) |
| CI-Tests on a repository with topic `docs` or `template` | `na` (1.2) |
| Fuzzing on a repository without a non-memory-safe language above 5% (`GET /repos/{o}/{r}/languages`) | `na` (QA.05) |
| `-1`, reason starts with `internal error` | `errors` (no data), never `na` |
| `-1` on CI-Tests while Code-Review counted changesets ("Found x/N approved changesets", N > 0) | `fail`: changes without pull requests |
| any other `-1` | `na` |
| `score` ≥ threshold | `pass` |
| `score` < threshold | `fail` |

The first three rows are decisions of `scorecard_check` that need no Scorecard data, so they come before the error rows: e.g. Branch-Protection on a managed repository is `na` even if Scorecard could not read the protection.

- `name`, `score`, `reason` and `details` are copied unchanged from Scorecard. `-1` becomes `score: null`, `details: null` becomes `[]`, `date` is converted to UTC.
- When `scorecard_check` decides the result itself (managed branch protection, topic `docs`/`template`, changes without pull requests), `reason` stays Scorecard's text and the first `details` line explains the decision, e.g. `Info: scorecard_check: not evaluated, branch-protection is managed by the org ruleset ospo-managed` or `Warn: scorecard_check: 30 changesets reached the default branch without pull requests`.
- **Reason text is parsed** only for the changeset count. A reason the parser does not recognise goes to `errors`, so a new Scorecard wording cannot silently turn a `fail` into `na`. The real output in `scripts/test/fixtures/` serves as test fixture.
- **Checks written:** every check in `thresholds` of `config/scorecard_check.yaml`. A configured check missing from the output goes to `errors`; a check of the output that is not configured (e.g. a new check in a newer Scorecard version) is ignored and named in the run log.
- **No usable output:** a repository Scorecard cannot scan (not JSON, timeout, or `checks: null`, which Scorecard returns for an empty repository) gets one `errors` row per configured check.
- **Observed on real data (7 Nov 2026, first run of `scorecard_check` on allianz):** all 5 active repositories scanned in about 15 seconds, without errors. `ng-aquila` and `ospo` carry the topic `docs`, so CI-Tests (QA.04) is `na` for them; if they are meant to count, the topic must go. Dangerous-Workflow and Token-Permissions are `-1` (`na`) for repositories without workflows.
- **Observed on real data (earlier):** ng-aquila had CI-Tests `-1` ("no pull request found") but 30 changesets in Code-Review, i.e. direct pushes to `main`. yukimi's Branch-Protection is 5 with the current ruleset (no status checks, 1 approval, no code-owner review), so a threshold of 6 needs a stricter ruleset. **(verify)**

### 1.10 Aggregation (`compliance_report`)

`compliance_report` turns the tool files in `results/` into one self-contained `data.json`. The HTML and Markdown reports are rendered from `data.json` only and never read a tool file, so every number in the report can be traced to `data.json`. The tool files are pinned by their `sha256` in `inputs`; they are not committed (1.4).

**Rule: `data.json` contains only what the report shows or the next run needs.** Everything else (e.g. `reason` and `details` of repository checks, `fix` for checks that have an issue) stays in the tool files and in the issues, which are written from them. If the report starts to show a field, it is added to `data.json` at the same time.

**Steps**

1. **Read and validate.** Read every tool file listed in the report configuration → `inputs`. Validate it against 1.6: all header fields present; `catalogue`, `results`, `skipped` and `errors` present; every `check` in `results` is in the file's catalogue; `result` is `pass`, `fail` or `na`. A missing or invalid file gets `status: missing` or `status: invalid` in `inputs` and contributes nothing else: its checks have no results, which the report shows as "no data".
2. **Record inputs.** One `inputs` entry per file: `file`, `script`, `status`, the `sha256` of the file as read, the header fields the report shows (`tool`, `run_at`, `ospo_sha`, `config_file`, `config_sha256`, `run_url`, `issue_title`, and where present `source`, `scorecard_version`), and `counts` (`results`, `skipped`, `errors`).
3. **Merge.** A check ID defined in two files is a bug and stops the run.
   - `catalogue`: the union of all catalogues. Each entry gets the defining `tool` and keeps `threshold` and `documentation` (`url`, `short`). `name` is dropped: the report shows the check ID. `fix` is kept only for checks the OSPO fixes and no issue carries: `compliance_report`'s own checks.
   - `results`, concatenated in input order. Each row keeps `repo`, `check` and `result`; `score` only for scored checks (the catalogue entry has a `threshold`). `name`, `reason` and `details` are not copied; the tool is found through `catalogue[check].tool`.
   - `skipped` and `errors`, concatenated, each row with `tool`.
4. **Add own results.** Every active repository that a tool skipped (`excluded_repos`) gets a `fail` result for each mapped per-repository check of that tool (1.2).
5. **Compute** from the merged results and the report configuration only:
   - `scope`: active and archived repositories;
   - `requirements`: the mapped checks, status and coverage per requirement (1.7);
   - `summary`: checks evaluated and passed, compliance %, requirements by status, active repositories with findings (`failing_repositories`).
6. **Carry forward** from the latest earlier `reports/<YYYY-MM>/<key>-data.json` in the local `reports/` folder (1.4): `history`. This run's entry is added for its month and replaces an existing entry of the same month. Nothing else is read from the previous run. No earlier report (first report): `history` starts empty and `previous_report` is `null`.
7. **Read the notes file** named by `notes:` (1.8), if configured: `notes` gets `file`, `sha256`, `key_messages` and `needs_attention` (each a list of inline-Markdown strings). Missing file: `notes: null`. Invalid file: `notes: null` and an entry in `errors` with `tool: compliance_report`.
8. **Write** `<key>-data.json`, then render `<key>-report.html` and `<key>-report.md` from it. The data-health banner at the top of the summary is generated and appears only when an input is `missing` or `invalid` or `errors` is not empty.

**`data.json` keys**

| Key | Content | Step |
|---|---|---|
| `report_id`, `run_at`, `org`, `ospo_sha`, `run_url` | This run; `report_id` is `OSPO-CR-<KEY>-<YYYY-MM>` | – |
| `report_config`, `config_sha256` | Path and hash of the report configuration, which pin the mapping that produced the statuses | – |
| `framework` | Copied from the report configuration | – |
| `previous_report` | The `data.json` on `main` that `history` was read from: its `report_id` and `data_url`, a link pinned to the commit of `main` that was read | 6 |
| `inputs` | One entry per tool file: status, hash, header, counts | 2 |
| `scope`, `requirements`, `summary` | Computed | 5 |
| `notes` | Hand-written text from the notes file, or `null` | 7 |
| `history` | Carried forward | 6 |
| `catalogue`, `results`, `skipped`, `errors` | Merged from the tool files, reduced to what the report shows, plus own results | 3, 4 |

- **Findings are not stored.** Which repository fails which requirement, and through which checks, is derived from `results` and `requirements` by the renderer. `data.json` stores no derived lists: if one is ever needed for performance, it goes into a block named `cache`, so it is obvious that it duplicates data.
- **Reproducible.** `summary` and the per-requirement counts can be recomputed from `results` and the mapping in `requirements`. A test recomputes them from `data.json` alone and compares.
- **Size.** `data.json` holds one short row per result (about 55 KB for the mock data, about the same as the tool files together, because it also carries the requirement texts, notes and history). The next run reads only `history` from it.

---

## Part 2: Requirements

### GV.01 · How to contribute is documented · MUST + SHOULD · ✅ Done

> Information on how to contribute to the project MUST be documented. Information about the expected quality of contributions SHOULD be given.

**Implementation:** Every repository must contain a contribution guide (`CONTRIBUTING` file in the root, `.github` or `docs`). An automated check runs every week and opens an issue in any repository that lacks one, until it is fixed.

- **Check:** `lint/contributing`, a structural check. A file `CONTRIBUTING*` exists in `.`, `.github` or `docs`.
- **Script:** `lint_repos` (exists).
- **Issue:** listed in the lint issue.
- **Evidence:** the file path found.

**SHOULD clause (quality of contributions):** not assessed in this version (see 1.7).

**New work:** done.

---

### GV.02 · Protected against unauthorised actions · MUST · ✅ Done

> The project's repository, websites and sensitive data MUST be protected against unauthorized actions.

**Implementation** (documented, not checked)
- **Repository:** Changes need a company account with SSO and MFA; 2FA is required for all members. The base permission is `none`: only teams get access, synced with Entra ID, and members cannot create repositories. Every permission change is a pull request and is approved first; `create_repos` applies it. The org ruleset `ospo-managed` protects the default branches: pull request required, no force-push, no deletion.
- **Websites:** published with GitHub Pages only, so the repository's access rules apply.
- **Sensitive data:** secret scanning and push protection are on for every repository through the security configuration `ospo-managed`.

**Exact checks** (Scorecard, per repository)
- `scorecard/branch-protection` ≥ 6, for repositories with `branch-protection: custom`. Repositories with managed branch protection get `na`: the org ruleset covers them (see 1.9). `scorecard_check` reads `config/create_repos.yaml` to know which repositories are custom.
- `scorecard/dangerous-workflow` = 10 and `scorecard/token-permissions` ≥ 8, for all repositories.

**Not checked in this version:** the org settings (2FA, base permission, repository creation), the ruleset, the security configuration, direct collaborators and drift between `config/create_repos.yaml` and GitHub. They are part of the implementation text only. SSO enforcement, MFA and Entra ID team sync have no API at all.

**Websites:** no check. The scope statement "GitHub Pages only" is in the implementation text.

**Issue:** none, JSON only (1.5).

**Script:** `scorecard_check` (exists, [spec](scorecard_check_spec.md)).

**New work:** done.

---

### LE.01 · License stated for all content · MUST · ✅ Done

> A license MUST be stated for all content made available by the project, including the project's documentation.

**Implementation:** Every repository must contain a license file with an approved license (Apache-2.0, MIT, CC-BY-4.0, CC0-1.0). The license file in the root applies to all content of the repository, including documentation and the Pages website, unless a file states otherwise. A weekly check opens an issue if the license is missing or not approved.

**Exact check:** `lint/license-type`: the SPDX ID detected by GitHub is on the approved list. No detected license (no license file) and `NOASSERTION` fail, so a separate file check is not needed. `lint_repos` keeps `LICENSE*` in `required_files` for its own issue, but that check is not mapped.

**Script:** `lint_repos` (exists).

**Issue:** listed in the lint issue.

**New work:** done.

---

### LE.02 · Licenses of all components referenced · MUST · ✅ Done

> A copy of all licenses in use, or references hereto, MUST be provided.

**Implementation:** For every repository, a public SPDX SBOM is available from the dependency graph. It lists every declared dependency with its license identifier, which is a reference to the license text. The project's own license is covered by LE.01.

**By construction:** `by-construction/sbom-available` (1.5), the same check as QA.01. The dependency graph is always enabled for public repositories and cannot be switched off, and every repository in scope is public (QA.02, `lint/public`).

**Script:** `by_construction` (exists).

**Limits of the check:** components not declared through a package manager (copied-in code) are not in the SBOM.

**Not part of the TR:** the deny list for dependency licenses (the existing `license_scan` issue) is internal policy. It stays in place, but is not written to the JSON and not in the report. Missing license information of components (`NOASSERTION`) is not measured: projects usually cannot fix upstream metadata.

**New work:** done (`by_construction`).


---

### QA.01 · List of third-party components available · MUST · ✅ Done

> A list of third-party components used in the software MUST be available.

**Implementation:** The dependency graph is enabled for every repository through the security configuration. Its SPDX SBOM is the public list of third-party components.

**By construction:** `by-construction/sbom-available` (shared with LE.02). For public repositories the dependency graph is always enabled and cannot be switched off, so the SBOM always exists; the precondition "public" is checked per repository by QA.02 (`lint/public`). `license_scan` still fetches the SBOM for its deny list; a 404 there (e.g. an empty repository **(verify)**) gives `license/denied-licenses` = `na`, not a finding.

**Issue:** none.

**Limits of the check:**
- Components that are not declared through a package manager are not listed.
- There is no SBOM per release. That is optional: the OSPO release workflow template (see BR.03) could attach one.

**New work:** done (`by_construction`, shared with LE.02). Done in `license_scan`: the former `license/sbom-available` check was removed.

---

### QA.02 · Source code publicly readable · MUST · ✅ Done

> All of the project's source code MUST be publicly readable.

**Implementation:** All repositories are created by the provisioning pipeline as public. A weekly check confirms that every repository in scope is public.

**Exact check:** `lint/public`. The visibility of every in-scope repository is `public`. This checks the result directly, so it also catches repositories created or switched to private by an admin.

**Precondition:** `lint_repos` lists all repositories of the organisation, including private and internal ones. The GitHub App must therefore be installed on all repositories, otherwise a private repository is invisible and cannot fail.

**Script:** `lint_repos`. The data is already in the repository list, so no extra call is needed.

**Issue:** none, JSON only (1.5). Project teams cannot change the visibility; it is a central action. The result is evidence for the report and audits.

**New work:** done.

---

### QA.03 · How to report defects is communicated · MUST · ✅ Done

> The project MUST inform how to report defects.

**Implementation:** Issues are enabled on every repository, and project teams cannot disable them. Security defects are reported privately (VM.01).

**Exact check:** `lint/issues-enabled`, i.e. `has_issues == true`.

**Issue:** none, JSON only (1.5). Project teams cannot disable Issues, so there is nothing for them to fix; the result is evidence for the report and audits. If Issues are disabled anyway, `lint_repos` also cannot open its own issue for the repository: it skips it and logs a warning.

**New work:** done.

---

### QA.04 · Testing procedures implemented and used · MUST · ✅ Done

> Procedures for testing MUST be implemented and utilised.

**Implementation:** Every repository with code tests its changes automatically in CI before pull requests are merged. A monthly check confirms that CI ran on recently merged pull requests.

**Exact check:** `scorecard/ci-tests` ≥ 8. Tests that run in CI are both implemented and utilised. Scorecard "inconclusive" → `na`, unless Code-Review counted changesets: then changes reached the default branch without pull requests, and the result is `fail` (see 1.9).

**Not applicable:** topics `docs` or `template` (applied by `scorecard_check`).

**Script:** `scorecard_check`.

**Issue:** none, JSON only (1.5).

**Limits of the check:** Scorecard detects that CI ran, not what it tested. Repositories without recent pull requests are inconclusive and therefore not applicable, so QA.04 says nothing about them until the next change. Whether `DEVELOPMENT.md` describes how to run the tests is not checked in this version.

**New work:** done (`scorecard_check`).

---

### QA.05 · Memory safety issues reduced · SHOULD · ✅ Done

> The project SHOULD take measures to reduce or avoid memory safety issues.

**Implementation:** Projects use memory-safe languages. Projects with more than 5% code in C, C++, Objective-C or assembly are fuzzed, through OSS-Fuzz or ClusterFuzzLite. Code scanning (CodeQL) runs on every repository through the security configuration.

**Policy:** for non-memory-safe code, fuzzing is the required measure. Sanitizers or other measures alone do not pass.

**Applicability:** repositories whose languages (`GET /repos/{o}/{r}/languages`) include a non-memory-safe language with more than 5% of the code. All others are not applicable, because the language choice itself is the measure.

**Exact check:** `scorecard/fuzzing` = 10 (Scorecard Fuzzing is 0 or 10). `scorecard_check` reads the languages and writes `na` for repositories without a non-memory-safe language above 5%, with a `details` line saying so; for the others it applies the threshold as usual.

**Not checked:** code scanning (CodeQL) through the security configuration is part of the implementation text only. **(verify** that code scanning is part of `ospo-managed`.)

**Script:** `scorecard_check` (languages, threshold).

**Issue:** none, JSON only (1.5).

**Limits of the check:** Scorecard recognises fuzzing mainly through OSS-Fuzz, ClusterFuzzLite and a few language-specific fuzzing frameworks. Whether an Objective-C or Swift project can reach 10 at all **(verify)**; if not, Objective-C comes off the list.

**New work:** done (`scorecard_check` reads the languages and applies `fuzzing.languages` and `fuzzing.min_share` from its configuration).

---

### QA.06 · Changes peer-reviewed · SHOULD · ✅ Done

> All changes to the source code SHOULD be peer-reviewed.

**Implementation:** The org ruleset requires a pull request with at least one approval before merging into the default branch.

**Exact check:** `scorecard/code-review` ≥ 7, for all repositories. It measures the effect, whatever the cause: it also covers repositories with custom branch protection, admin bypasses and direct pushes. The ruleset setting itself is not checked; if it is weakened, Code-Review drops gradually, because Scorecard looks at the last ~30 changesets.

**Single-maintainer projects:** a required approval would block them. How they get a second reviewer is a policy decision; until then they fail QA.06.

**Script:** `scorecard_check`.

**Issue:** none, JSON only (1.5).

**New work:** the check is done. Still open: the policy decision for single-maintainer projects.

---

### BR.01 · Build information public · MUST · ✅ Done

> Information on how to build all software assets MUST be publicly available.

**Implementation:** Every repository with code contains `DEVELOPMENT.md` (in the root, `docs` or `.github`) describing how to build and test it. New repositories get a template.

**Structural check:** `lint/development`: `DEVELOPMENT*` or `DEVELOPER*` exists in `.`, `docs` or `.github`, with at least 300 characters (`min_chars`). A "Build" heading is not checked in this version.

**Applies to:** all active repositories. There is no topic-based applicability: a repository without software (e.g. `docs`) passes with a short DEVELOPMENT.md that says how to build or preview its content.

**Script:** `lint_repos` (a `required_files` entry with `json_only: true`).

**Issue:** none, JSON only (1.5), by decision. Findings are shown in the report only; the lint issue is not opened or kept open for a missing DEVELOPMENT file.

**Limits of the check:** only the file is checked, not whether it describes the build. Correctness of the instructions is the project team's responsibility.

**Preventive:** `create_repos` adds the template to new repositories. **(New capability:** today `create_repos` creates empty repositories; adding a file requires a commit through the API.)

**Rollout:** none needed. Without an issue, project teams are not asked to act; the report shows the findings from the first run.

**New work:** the check is done. Still open, as a preventive measure: the template in `create_repos`.

---

### BR.02 · Unique, increasing version identifiers · MUST · ✅ Done

> All releases and released software assets intended for use MUST be assigned unique, monotonically increasing version identifiers.

**Implementation:** Releases are tagged with SemVer (or CalVer). Tags are unique by construction in git. A monthly check confirms that release versions increase.

**Exact check:** `releases/versioning` ([spec](releases_check_spec.md#versioning)), on the releases of the last 12 months (`GET /repos/{o}/{r}/releases`, drafts excluded):
- Every tag parses as SemVer or CalVer (an optional `v` prefix is allowed).
- Within each major version line, versions increase with release date. This allows backport releases on older lines, as the TR note ("within a branch") describes.
- Pre-releases are included.

**Applies to:** releasing repositories. Others get `na`.

**Script:** `releases_check` (exists). The releases call is shared with BR.04.

**Issue:** none, JSON only (1.5), by decision. Findings are shown in the report only.

**New work:** done.

---

### BR.03 · Integrity of distributed assets verifiable · MUST (+ MAY) · ✅ Done

> All assets MUST be distributed in a way that maintains integrity or at least allows its verification. Means to maintain and verify authenticity MAY be deployed.

**Implementation**
- **Source archives:** GitHub generates them from the tag and serves them over HTTPS. That is integrity by construction.
- **Release assets:** built by the OSPO release workflow template, which adds SHA-256 checksums and a GitHub artifact attestation. The attestation is signed, so it also covers the MAY part (authenticity).

**Exact check:** `scorecard/signed-releases` ≥ 8 (provenance gives 10). **(verify** how Scorecard scores releases without uploaded assets: these should count as `na`, because only source archives exist.)

**Applies to:** releasing repositories with uploaded release assets.

**Script:** `scorecard_check`.

**Issue:** none, JSON only (1.5).

**Limits of the check:** packages published to registries (npm, Maven Central) are not covered by Signed-Releases. Registry provenance (e.g. npm provenance) could be a later check.

**Prerequisite:** the OSPO release workflow template. Without it, projects cannot fix the finding.

**New work:** the check is done. Still open: the release workflow template, without which projects cannot fix the finding.

---

### BR.04 · Change log per release · MUST · ✅ Done

> All releases MUST provide a descriptive log of functional and security modifications.

**Implementation:** Every GitHub release has release notes. The release template enables generated release notes, grouped by labels such as `security` (`.github/release.yml`).

**Structural check:** `releases/release-notes` ([spec](releases_check_spec.md#release-notes)). Every release of the last 12 months has a release body of at least 50 characters (`min_notes_chars`), or the `CHANGELOG*` file in the repository root mentions the version. The changelog is read through the contents API, only when a release body is too short.

**Applies to:** releasing repositories. Others get `na`.

**Script:** `releases_check` (exists; shares the releases call with BR.02).

**Issue:** none, JSON only (1.5), by decision. Findings are shown in the report only.

**Limits of the check:** whether the notes describe all functional and security changes cannot be checked.

**New work:** the check is done. Still open, as a preventive measure: a release-notes configuration in the template.

---

### BR.05 · Source packages match the repository · MUST · ✅ Done

> Released source packages MUST NOT contain any content that is not present in the project's repository or cannot be deterministically generated from it.

**Implementation**
- **Source packages:** the GitHub-generated archives of the tag. They contain exactly the repository content at that tag.
- **Built packages:** produced by the release workflow from the tagged commit. The artifact attestation (BR.03) links each asset to that commit.

**By construction:** for GitHub-generated source archives.

**Covered by BR.03:** for built assets, through the attestation.

**Check:** `by-construction/source-archives`, a check of the tool `by_construction` (1.5): always `pass`, one per active repository. GitHub generates source archives from the tag, so they always match the repository content; there is nothing to test. It adds one passing result per active repository to the compliance %.

**Limits:** source tarballs uploaded by hand as release assets are not covered. The release template removes the need for them.

**New work:** done (`by_construction`).


---

### BR.06 · Builds reproducible · SHOULD · ➖ Not assessed

> Builds SHOULD be reproducible.

**Not verifiable** at portfolio scale → status "Not assessed", not counted. Reassessed once BR.03 is met.

**New work:** none.

---

### VM.01 · Security contact and private reporting · MUST + SHOULD · ✅ Done

> The project documentation MUST contain security contacts for reporting vulnerabilities. There SHOULD be a way to do so privately.

**Implementation:** An organisation-wide `SECURITY.md` in `allianz/.github` applies to every repository without its own. It names the OSPO as contact and asks for private vulnerability reporting, which is enabled on every repository.

**Exact check:** `scorecard/security-policy` = 10, for all repositories. Scorecard finds a `SECURITY.md` in the repository or, if there is none, the org default in `allianz/.github`, and scores its content: linked content (contact), disclosure text, free text. Observed on real data: yukimi scores 10 through `allianz/.github/SECURITY.md`. A repository with its own policy that names no contact scores lower and fails. **(verify** the scoring of a repository's own policy without disclosure text.)

**Script:** `scorecard_check`.

**Issue:** none, JSON only (1.5).

**SHOULD clause (private reporting):** not assessed in this version (see 1.7). Private vulnerability reporting is still enabled through the `ospo-managed` security configuration. Neither the security configuration nor individual repositories are checked for it.

**New work:** done.

---

### VM.02 · Vulnerabilities published in reasonable time · MUST · ✅ Done

> The project MUST publish information about discovered vulnerabilities within a reasonable period of time.

**Implementation:** Vulnerabilities reported privately are triaged by the project team and the OSPO, and published as a GitHub Security Advisory with a CVE, within 90 days of the report.

**Exact check:** `advisories/published-in-time`, one result per active repository. Only public information is used: the published advisories of the repository (`GET /repos/{owner}/{repo}/security-advisories?state=published`).
- `pass` if every advisory published in the last 12 months was published within 90 days of its creation (`published_at` − `created_at`), or if there is none.
- `fail` if at least one took longer. A late publication therefore counts for 12 months.
- `reason` names each advisory and its days to publication, e.g. "1 advisory published in the last 12 months: GHSA-7q4x-2m9c-h3vf after 18 days".

**Script:** `advisories_check` (exists, [spec](advisories_check_spec.md)). JSON only.

**Issue:** none. A failure is a past event that the project team cannot fix any more; it disappears after 12 months.

**Limits of the check:** advisories in `triage` or `draft` and closed ones are not public and are not counted, so an advisory that is never published never fails the check. Whether `created_at` is the time of the private report **(verify)**. Vulnerabilities reported through other channels (e.g. email to the OSPO) are only measured from the moment an advisory is created. The process statement covers this: every report becomes an advisory.

**New work:** done.

---

### DE.01 · Discontinuation communicated · SHOULD · ✅ Done

> Discontinuation of the project, parts of it, or specific versions or version ranges SHOULD be communicated adequately.

**Implementation:** Every active repository is checked for activity in each weekly run. Repositories without activity for 12 months get a public notice issue (`warn_after: "1 years"`). After 60 more days (`grace_period: "60 days"`) without activity they are archived and leave the scope. The notice issue stays visible on the archived repository, and GitHub marks the repository as archived and read-only.

**What is verified:** that the process covers every repository in scope, not each individual notice. A repository the process does not check could go unmaintained without anyone noticing; a repository it checks is either active or on its way to archival with a notice. Archived repositories are out of scope (1.2) and have no result.

**Exact check**
- `archive/activity-checked` (`archive_repos`): one result per active repository. `pass` if `archive_repos` read the repository's last activity in this run; the `reason` states the last push and, if one is open, the notice issue and the archival date. An active repository that `archive_repos` skips (`excluded_repos`) gets a `fail` from `compliance_report` (1.10 step 4); one it could not evaluate is listed under `errors`.

**Script:** `archive_repos`: adds `--json` with one `archive/activity-checked` result per repository it evaluated. It needs no history and no new API calls: it already reads the last push of every repository.

**Issue:** none. `archive_repos` itself never fails the check; a failure is a configuration matter for the OSPO (`fix` names it).

**Limits:** discontinued *versions* (end of life of a major line) are not covered. That is a project decision and not detectable. Whether the notice was given before an archival is not checked: archival only happens through the notice process, and an archived repository is out of scope either way.

**New work:** done in `archive_repos`. The `fail` for excluded repositories comes with `compliance_report`.

---

### DE.02 · Migration paths outlined · MAY · ➖ Not assessed

> If the project, parts of it, or specific versions are discontinued, migration paths MAY be outlined, for example by naming a successor project or a maintained alternative and describing how users can move to it.

**Currently not done, status `not-assessed`.** We will revisit this requirement once the open source programme is more mature.

**New work:** none.

