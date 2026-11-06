# DRAFT: BSI TR-03185 Chapter 2 implementation plan

Temporary working document, not meant to be kept. It lists every requirement of BSI TR-03185 v1.1.1 Chapter 2 and how it will be implemented and verified. Items marked **(verify)** are assumptions about GitHub or Scorecard behaviour that must be confirmed before implementation.

---

## Part 1: Shared rules

Every requirement entry in Part 2 uses these rules. If an entry seems to contradict them, the rules win and the entry needs fixing.

### 1.1 Verification types

Every check has exactly one type:

| Type | When to use | What proves it |
|---|---|---|
| **Exact check** | Can change per repository, and the condition can be tested precisely | A per-repository check with a clear pass/fail |
| **Structural check** | Can change per repository, but only the form can be tested, not the content | A per-repository check, plus a "Limits of the check" note on the card |
| **By construction** | GitHub guarantees it; there is nothing to check | A check of the virtual tool `by-construction` (1.5): always `pass`, one per active repository. Not a test; its rule says so |
| **Not verifiable** | No practical way to verify (SHOULD or MAY only) | Nothing. The requirement has status "Not assessed" and is not counted |

Rule: a MUST can never rely on **Not verifiable**. Central settings (org settings, ruleset, security configuration) are not a check type: they are described in the implementation text, and their effect is measured per repository where a check exists (e.g. GV.02).

### 1.2 Scope and applicability

- **In scope:** all active (not archived) repositories of the organisation. A repository in a tool's `excluded_repos` stays in scope: the tool skips it and lists it under `skipped`, and `compliance_report` counts it as failing every mapped per-repository check of that tool (see 1.10 step 4).
- **Archived repositories:** the checking tools list them under `skipped` (reason `archived`) and write no results for them. They are out of scope, so no check has results for them.
- **Not applicable by topic:** repositories tagged `docs` or `template` have no software to build or test. BR.01 and QA.04 do not apply to them.
- **Releasing repositories:** repositories with at least one GitHub release in the last 12 months. BR.02–BR.04 only apply to these.
- **Not applicable by data:** when a check has no data to judge (e.g. Scorecard "inconclusive" because there were no changes), the result is `na`, not `pass`. A tool error is never `na`: it goes to `errors`, which the report treats as "no data".

### 1.3 Scripts and their roles

Every checking script works the same way: it **runs its checks, owns its issues, and writes a JSON result**. The report script only reads JSON files. It never changes anything on GitHub.

| Script | Status | Role |
|---|---|---|
| `create_repos.js` | exists | Preventive: provisions repositories, teams, security configuration, ruleset targets. Not part of the weekly compliance run. |
| `lint_repos.js` | exists, extend | Per-repository checks on repository data and the cloned content |
| `license_scan.js` | exists, extend | SBOM retrieval and dependency licenses |
| `archive_repos.js` | exists, extend | Inactivity notices and archival |
| `advisories_check.js` | **new** | Checks the published security advisories of every repository (VM.02). Writes results only. No issues. |
| `scorecard_check.js` | **new** | Runs the Scorecard CLI per repository, converts its output to the common format, applies thresholds and applicability (e.g. languages for fuzzing, QA.05), opens and closes issues (see 1.9) |
| `compliance_report.js` | **new** | Runs once per report configuration (1.8). Aggregates all tool files into one self-contained `data.json` per report (see 1.10): merges results, maps checks to requirements, computes statuses. Renders HTML and Markdown from `data.json` only |

### 1.4 Weekly workflow

One workflow, `compliance.yaml`, runs every week and replaces the separate schedules of `lint_repos`, `license_scan` and `archive_repos`. It runs all tools one after another in one job. Each tool writes its JSON file into a local directory `out/`; then `compliance_report` aggregates them:

```
lint_repos --json               → out/lint_repos.json
license_scan --json             → out/license_scan.json
archive_repos --json            → out/archive_repos.json
advisories_check                → out/advisories_check.json
scorecard_check                 → out/scorecard.json
compliance_report --config config/compliance_report_bsi.yaml
                                ← out/*.json + previous bsi-data.json + its notes file
                                → out/bsi-data.json, out/bsi-report.html, out/bsi-report.md
compliance_report --config config/compliance_report_allianz.yaml
                                ← out/*.json + previous allianz-data.json + its notes file
                                → out/allianz-data.json, out/allianz-report.html, out/allianz-report.md
release compliance-YYYY-MM-DD   ← the files of every report, all tool files (once)
```

- **One run, several reports.** The tools run once; each report configuration (1.8) turns the same tool files into its own report. The release of a run holds all reports, so they always rest on the same evidence. Asset names start with the report's `key`.

- Each tool step runs with `continue-on-error`, and `compliance_report` always runs. A missing or invalid tool file means "no data", never "pass" (see 1.10).
- `compliance_report` downloads `<key>-data.json` of its own report from the previous release, which carries the trend history. Each report has its own history. The checking scripts never read a previous run.
- The tool files are published in the release as evidence. The report itself is rendered from `data.json` only.

### 1.5 Check IDs, issues and labels

- **Check IDs** have the form `<tool>/<check>`. The prefix names the tool that defines the check:

  | Prefix | Tool |
  |---|---|
  | `lint/` | `lint_repos` |
  | `license/` | `license_scan` |
  | `archive/` | `archive_repos` |
  | `advisories/` | `advisories_check` |
  | `scorecard/` | `scorecard_check` |
  | `by-construction/` | virtual tool, see below |

- **`by-construction` is a virtual tool.** It has no script, no input file and no API call; it tests nothing and always passes. Its checks stand for guarantees GitHub gives by design, e.g. `by-construction/source-archives`: the source archives of a release are generated by GitHub from the tag, so they always match the repository content (BR.05). `compliance_report` writes its results, one `pass` per active repository (1.10 step 4), so that such a requirement has statuses, coverage and a card like every other requirement. The rule text of each check starts with "Not a test; always passes", and the report shows it under "How it is verified". It adds passing results to the compliance %.
- **Requirement mapping** exists in one place only: the report configuration (1.8), one per report. Each report maps the same check IDs to its own requirements. The scripts know nothing about requirement IDs.
- **Issues:** each tool keeps one issue per repository, as `lint_repos` does today. That issue lists all failing checks of that tool. Issues are a convenience for the project teams. The report does not read them, and they do not affect any status: a team may close an issue without fixing the finding, and the tool opens it again on the next run. The report only links to the live issues on GitHub.
- **Labels:** the issue carries one label per failing check, e.g. `lint/contributing`. Labels are added and removed as checks change. The report's "Live issues" link searches by label, e.g. `org:allianz is:issue is:open label:lint/contributing`.
- **Security-sensitive results never become public issues.** If a check ever produces one, the tool opens no issue, and the public report shows counts only. No check in this version does.
- **Issues disabled or archived:** a tool cannot open an issue in a repository whose issues are switched off (QA.03) or that is archived. It logs a warning in its workflow run. This is a tool problem, not a report concern; the finding is in the report either way.

### 1.6 Common JSON format

```json
{
  "tool": "lint_repos",
  "run_at": "2026-11-03T02:00:00Z",
  "org": "allianz",
  "ospo_sha": "869f4bb",
  "config_sha256": "…",
  "run_url": "https://github.com/allianz/ospo/actions/runs/…",
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
| `check` | Stable ID `<tool>/<check>`. Key for history, labels and the requirement mapping |
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
- `skipped` lists repositories without results (excluded, archived). `errors` lists repository × check pairs the tool could not evaluate. Both are always present, `[]` if empty, so every file has the same shape.

### 1.7 Status logic (computed by the report)

Each requirement is assessed once, at its own level: a MUST requirement on its MUST clause, a SHOULD requirement on its SHOULD clause. Weaker clauses inside a requirement (the SHOULD in GV.01 and VM.01, the MAY in BR.03) are not assessed in this version. A requirement has one list of checks and one coverage figure: a repository passes only if it passes every applicable check of the requirement.

- **Met:** all applicable repositories pass.
- **Met, with findings:** some applicable repositories fail.
- **Not met:** no check covers a MUST requirement.
- **Not assessed:** no check can verify a SHOULD or MAY requirement (e.g. BR.06, DE.02). It is shown in the report, but not counted in the summary.
- **Optional:** a MAY requirement with checks, reported for information. No requirement uses it in this version.

- **Findings count repositories.** A repository has a finding for a requirement if it fails at least one applicable check of that requirement. Every number in the report counts repositories (per requirement, or active repositories with at least one finding), never failing checks: which checks implement a requirement is an implementation detail, and one missing file can fail several checks. Failing checks are shown only as the explanation next to a repository.

- **Trend:** each run appends to `data.json` → `history` the overall compliance, the number of active repositories with findings (`failing_repositories`) and, per requirement, the share of applicable repositories that pass (`coverage`). Each value is computed from that run's own results; a missed run is a gap, not a wrong value.

- **No finding age:** the report does not compute how long a finding has been open. A "failing since" date would have to be carried forward from run to run, and it would silently reset on a missed run, a renamed repository or check, or a check that flaps. The live issues on GitHub show a finding's history.

### 1.8 Report configurations

One configuration file per report. Every file and file name is set in the configuration; nothing is derived from the requirement set. Today there are two:

| Configuration | Report | Notes file |
|---|---|---|
| `config/compliance_report_bsi.yaml` | BSI TR-03185 Chapter 2 | `config/compliance_report_bsi_notes.md` |
| `config/compliance_report_allianz.yaml` | Allianz open source compliance | `config/compliance_report_allianz_notes.md` |

```yaml
# config/compliance_report_bsi.yaml
key: bsi                     # prefix of asset names (bsi-data.json, …) and of the report ID (OSPO-CR-BSI-2026-11-03)
framework:                   # requirement set, copied into data.json → framework
  id: bsi-tr-03185
  title: BSI TR-03185 Chapter 2
  version: 1.1.1
  url: https://www.bsi.bund.de/dok/TR-03185-en
  chapters: { GV: Governance, LE: Legal, QA: Quality, BR: Build and release, VM: Vulnerability management, DE: Decommissioning }

inputs:                      # tool files expected in out/ (see 1.10)
  - { file: lint_repos.json,    script: scripts/lint_repos.js }
  - { file: license_scan.json,  script: scripts/license_scan.js }
  - { file: archive_repos.json, script: scripts/archive_repos.js }
  - { file: advisories_check.json, script: scripts/advisories_check.js }
  - { file: scorecard.json,     script: scripts/scorecard_check.js }

notes: config/compliance_report_bsi_notes.md   # optional, any path; see below

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

**Notes file.** "Key messages" and "Needs attention" in the report are written by hand, never generated: they say what the numbers cannot (causes, decisions, owners, dates). Each report has its own notes file, set by `notes:` in its configuration; without `notes:` the report has no commentary. The OSPO updates it from time to time through a PR. It is kept apart from the configuration, so `config_sha256` still changes only when the mapping changes.

```markdown
---
as_of: 2026-11-03            # the run the text was written for
---

## Key messages

- **Release integrity is the weakest area.** Only 2 of 5 releasing repositories sign their releases (BR.03).

## Needs attention

- **Decision: ng-aquila license review** (Legal, by 30 Nov 2026). Until it is done, `ng-aquila` fails 15 requirements.
```

- Exactly these two headings, each a list of bullets. Inline Markdown only: `**bold**`, `` `code` ``, `[text](https://…)`. Anything else makes the file invalid.
- `as_of` is required and must not be later than the run. The report shows "Written for the run of …" under each box, highlighted with "N weeks before this run" once the text is older than the run.
- No file, an empty section, or an invalid file: the box is hidden. An invalid file is also reported in the data-health banner (1.10).
- Text in the file is published as is. It must follow the same rule as issues: nothing security-sensitive (1.5).

### 1.9 Scorecard conversion (`scorecard_check`)

**Source:** the Scorecard CLI, `scorecard --repo=github.com/<org>/<repo> --format=json --show-details`, run for every in-scope repository in the weekly workflow, with a pinned version. The public API (`api.scorecard.dev`) only has results for repositories that run the Scorecard Action with `publish_results`; on 4 Nov 2026 that was 1 of 5 active allianz repositories. The CLI output is identical to the API response except `date` (local time) and an extra `metadata: null` (see `mock_data/scorecard_*_real_yukimi.json`).

**Conversion per check** (match by `name`, not by position):

| Scorecard | Result |
|---|---|
| `score` ≥ threshold | `pass` |
| `score` < threshold | `fail` |
| `-1`, reason starts with `internal error` | `errors` (no data), never `na` |
| `-1` on CI-Tests while Code-Review counted changesets ("Found x/N approved changesets", N > 0) | `fail`: changes without pull requests |
| any other `-1` | `na` |
| Branch-Protection on a `branch-protection: managed` repository | `na` (protected by the org ruleset `ospo-managed`, documented in GV.02) |

- `name`, `score`, `reason` and `details` are copied unchanged from Scorecard. `-1` becomes `score: null`, `details: null` becomes `[]`, `date` is converted to UTC.
- When `scorecard_check` decides the result itself (managed branch protection, topic `docs`/`template`, changes without pull requests), `reason` stays Scorecard's text and the first `details` line explains the decision, e.g. `Info: scorecard_check: not evaluated, branch-protection is managed by the org ruleset ospo-managed` or `Warn: scorecard_check: 30 changesets reached the default branch without pull requests`.
- **Reason text is parsed** only for the changeset count. A reason the parser does not recognise goes to `errors`, so a new Scorecard wording cannot silently turn a `fail` into `na`. The real outputs in `mock_data/` serve as test fixtures.
- **Observed on real data:** ng-aquila had CI-Tests `-1` ("no pull request found") but 30 changesets in Code-Review, i.e. direct pushes to `main`. yukimi's Branch-Protection is 5 with the current ruleset (no status checks, 1 approval, no code-owner review), so a threshold of 6 needs a stricter ruleset. **(verify)**

### 1.10 Aggregation (`compliance_report`)

`compliance_report` turns the tool files in `out/` into one self-contained `data.json`. The HTML and Markdown reports are rendered from `data.json` only and never read a tool file, so every number in the report can be traced to `data.json`. The tool files stay in the release as evidence, pinned by their `sha256` in `inputs`.

**Rule: `data.json` contains only what the report shows or the next run needs.** Everything else (e.g. `reason` and `details` of repository checks, `fix` for checks that have an issue) stays in the tool files and in the issues, which are written from them. If the report starts to show a field, it is added to `data.json` at the same time.

**Steps**

1. **Read and validate.** Read every tool file listed in the report configuration → `inputs`. Validate it against 1.6: all header fields present; `catalogue`, `results`, `skipped` and `errors` present; every `check` in `results` is in the file's catalogue; `result` is `pass`, `fail` or `na`. A missing or invalid file gets `status: missing` or `status: invalid` in `inputs` and contributes nothing else: its checks have no results, which the report shows as "no data".
2. **Record inputs.** One `inputs` entry per file: `file`, `script`, `status`, the `sha256` of the file as read, the header fields the report shows (`tool`, `run_at`, `ospo_sha`, `config_file`, `config_sha256`, `run_url`, and where present `source`, `scorecard_version`), and `counts` (`results`, `skipped`, `errors`).
3. **Merge.** A check ID defined in two files is a bug and stops the run.
   - `catalogue`: the union of all catalogues. Each entry gets the defining `tool` and keeps `threshold` and `documentation` (`url`, `short`). `name` is dropped: the report shows the check ID. `fix` is kept only for checks the OSPO fixes and no issue carries: `compliance_report`'s own checks.
   - `results`, concatenated in input order. Each row keeps `repo`, `check` and `result`; `score` only for scored checks (the catalogue entry has a `threshold`). `name`, `reason` and `details` are not copied; the tool is found through `catalogue[check].tool`.
   - `skipped` and `errors`, concatenated, each row with `tool`.
4. **Add own results.** `compliance_report` writes the checks of the virtual tool `by-construction` (1.5), one `pass` per active repository, with catalogue entries `tool: compliance_report`. They open no issues. In addition, every active repository that a tool skipped (`excluded_repos`) gets a `fail` result for each mapped per-repository check of that tool (1.2).
5. **Compute** from the merged results and the report configuration only:
   - `scope`: active and archived repositories;
   - `requirements`: the mapped checks, status and coverage per requirement (1.7);
   - `summary`: checks evaluated and passed, compliance %, requirements by status, active repositories with findings (`failing_repositories`).
6. **Carry forward** from `<key>-data.json` of the previous release: `history` (this run is appended). Nothing else is read from the previous run.
7. **Read the notes file** named by `notes:` (1.8), if configured: `notes` gets `file`, `sha256`, `as_of`, `key_messages` and `needs_attention` (each a list of inline-Markdown strings). Missing file: `notes: null`. Invalid file: `notes: null` and an entry in `errors` with `tool: compliance_report`.
8. **Write** `<key>-data.json`, then render `<key>-report.html` and `<key>-report.md` from it. The data-health banner at the top of the summary is generated and appears only when an input is `missing` or `invalid` or `errors` is not empty.

**`data.json` keys**

| Key | Content | Step |
|---|---|---|
| `report_id`, `run_at`, `org`, `ospo_sha`, `run_url` | This run; `report_id` is `OSPO-CR-<KEY>-<date>` | – |
| `report_config`, `config_sha256` | Path and hash of the report configuration, which pin the mapping that produced the statuses | – |
| `framework` | Copied from the report configuration | – |
| `previous_report` | The `data.json` that `history` was read from | 6 |
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

### GV.01 · How to contribute is documented · MUST + SHOULD

> Information on how to contribute to the project MUST be documented. Information about the expected quality of contributions SHOULD be given.

**Implementation:** Every repository must contain a contribution guide (`CONTRIBUTING` file in the root, `.github` or `docs`). An automated check runs every week and opens an issue in any repository that lacks one, until it is fixed.

- **Check:** `lint/contributing`, a structural check. A file `CONTRIBUTING*` exists in `.`, `.github` or `docs`.
- **Script:** `lint_repos` (exists).
- **Issue:** lint issue, label `lint/contributing`.
- **Evidence:** the file path found.

**SHOULD clause (quality of contributions):** not assessed in this version (see 1.7).

**New work:** labels and `--json` only. The check itself already exists.

---

### GV.02 · Protected against unauthorised actions · MUST

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

**Issue:** Scorecard issue per check.

**New work:** the `scorecard_check` thresholds.

---

### LE.01 · License stated for all content · MUST

> A license MUST be stated for all content made available by the project, including the project's documentation.

**Implementation:** Every repository must contain a license file with an approved license (Apache-2.0, MIT, CC-BY-4.0, CC0-1.0). The license file in the root applies to all content of the repository, including documentation and the Pages website, unless a file states otherwise. A weekly check opens an issue if the license is missing or not approved.

**Exact check:** `lint/license-type`: the SPDX ID detected by GitHub is on the approved list. No detected license (no license file) and `NOASSERTION` fail, so a separate file check is not needed. `lint_repos` keeps `LICENSE*` in `required_files` for its own issue, but that check is not mapped.

**Script:** `lint_repos` (exists).

**Issue:** lint issue, label `lint/license-type`.

**New work:** labels and `--json` only.

---

### LE.02 · Licenses of all components referenced · MUST

> A copy of all licenses in use, or references hereto, MUST be provided.

**Implementation:** For every repository, a public SPDX SBOM is available from the dependency graph. It lists every declared dependency with its license identifier, which is a reference to the license text. The project's own license is covered by LE.01.

**Exact check**
- `license/sbom-available`: the SBOM can be retrieved for the default branch. This is the same check as QA.01.

**Script:** `license_scan` (extend).

**Limits of the check:** components not declared through a package manager (copied-in code) are not in the SBOM.

**Not part of the TR:** the deny list for dependency licenses (the existing `license_scan` issue) is internal policy. It stays in place, but is not written to the JSON and not in the report. Missing license information of components (`NOASSERTION`) is not measured: projects usually cannot fix upstream metadata.

**New work:** record `license/sbom-available` per repository, plus `--json`.

> Differs from the mock-up: LE.02 becomes "Met" based on SBOM availability. The `NOASSERTION` share is not reported.

---

### QA.01 · List of third-party components available · MUST

> A list of third-party components used in the software MUST be available.

**Implementation:** The dependency graph is enabled for every repository through the security configuration. Its SPDX SBOM is the public list of third-party components.

**Exact check:** `license/sbom-available` (shared with LE.02). The SBOM endpoint only answers when the dependency graph is enabled, so a disabled dependency graph fails this check per repository. The security configuration setting itself is not checked.

**Issue:** `license_scan` issue, label `license/sbom-available`. Today `license_scan` opens issues only for denied licenses; it must also open one when the SBOM is missing.

**Limits of the check:**
- Components that are not declared through a package manager are not listed.
- There is no SBOM per release. That is optional: the OSPO release workflow template (see BR.03) could attach one.

**New work:** a failure path in `license_scan`, plus labels.

---

### QA.02 · Source code publicly readable · MUST

> All of the project's source code MUST be publicly readable.

**Implementation:** All repositories are created by the provisioning pipeline as public. A weekly check confirms that every repository in scope is public.

**Exact check:** `lint/public`. The visibility of every in-scope repository is `public`. This checks the result directly, so it also catches repositories created or switched to private by an admin.

**Precondition:** `lint_repos` lists all repositories of the organisation, including private and internal ones. The GitHub App must therefore be installed on all repositories, otherwise a private repository is invisible and cannot fail.

**Script:** `lint_repos`. The data is already in the repository list, so no extra call is needed.

**Issue:** none. A private repository is not readable by the public, so a public issue makes no sense, and making a repository private is a central action anyway.

**New work:** one small check.

---

### QA.03 · How to report defects is communicated · MUST

> The project MUST inform how to report defects.

**Implementation:** Issues are enabled on every repository, and project teams cannot disable them. Security defects are reported privately (VM.01).

**Exact check:** `lint/issues-enabled`, i.e. `has_issues == true`.

**Issue:** not possible when issues are disabled. The tool logs a warning (see 1.5).

**New work:** one small check.

---

### QA.04 · Testing procedures implemented and used · MUST

> Procedures for testing MUST be implemented and utilised.

**Implementation:** Every repository with code tests its changes automatically in CI before pull requests are merged. A weekly check opens an issue when CI did not run on recently merged pull requests.

**Exact check:** `scorecard/ci-tests` ≥ 8. Tests that run in CI are both implemented and utilised. Scorecard "inconclusive" → `na`, unless Code-Review counted changesets: then changes reached the default branch without pull requests, and the result is `fail` (see 1.9).

**Not applicable:** topics `docs` or `template` (applied by `scorecard_check`).

**Script:** `scorecard_check`.

**Issue:** Scorecard issue, label `scorecard/ci-tests`.

**Limits of the check:** Scorecard detects that CI ran, not what it tested. Repositories without recent pull requests are inconclusive and therefore not applicable, so QA.04 says nothing about them until the next change. Whether `DEVELOPMENT.md` describes how to run the tests is not checked in this version.

**New work:** comes with `scorecard_check`.

---

### QA.05 · Memory safety issues reduced · SHOULD

> The project SHOULD take measures to reduce or avoid memory safety issues.

**Implementation:** Projects use memory-safe languages. Projects with more than 5% code in C, C++, Objective-C or assembly are fuzzed, through OSS-Fuzz or ClusterFuzzLite. Code scanning (CodeQL) runs on every repository through the security configuration.

**Policy:** for non-memory-safe code, fuzzing is the required measure. Sanitizers or other measures alone do not pass.

**Applicability:** repositories whose languages (`GET /repos/{o}/{r}/languages`) include a non-memory-safe language with more than 5% of the code. All others are not applicable, because the language choice itself is the measure.

**Exact check:** `scorecard/fuzzing` = 10 (Scorecard Fuzzing is 0 or 10). `scorecard_check` reads the languages and writes `na` for repositories without a non-memory-safe language above 5%, with a `details` line saying so; for the others it applies the threshold as usual.

**Not checked:** code scanning (CodeQL) through the security configuration is part of the implementation text only. **(verify** that code scanning is part of `ospo-managed`.)

**Script:** `scorecard_check` (languages, threshold).

**Issue:** Scorecard issue, label `scorecard/fuzzing`, only for applicable repositories.

**Limits of the check:** Scorecard recognises fuzzing mainly through OSS-Fuzz, ClusterFuzzLite and a few language-specific fuzzing frameworks. Whether an Objective-C or Swift project can reach 10 at all **(verify)**; if not, Objective-C comes off the list.

**New work:** the language lookup in `scorecard_check`.

---

### QA.06 · Changes peer-reviewed · SHOULD

> All changes to the source code SHOULD be peer-reviewed.

**Implementation:** The org ruleset requires a pull request with at least one approval before merging into the default branch.

**Exact check:** `scorecard/code-review` ≥ 7, for all repositories. It measures the effect, whatever the cause: it also covers repositories with custom branch protection, admin bypasses and direct pushes. The ruleset setting itself is not checked; if it is weakened, Code-Review drops gradually, because Scorecard looks at the last ~30 changesets.

**Single-maintainer projects:** a required approval would block them. How they get a second reviewer is a policy decision; until then they fail QA.06.

**Script:** `scorecard_check`.

**Issue:** Scorecard issue, label `scorecard/code-review`.

**New work:** the Scorecard threshold, and the policy decision.

---

### BR.01 · Build information public · MUST

> Information on how to build all software assets MUST be publicly available.

**Implementation:** Every repository with code contains `DEVELOPMENT.md` (in the root, `docs` or `.github`) describing how to build and test it. New repositories get a template.

**Structural check:** `lint/development-file`: `DEVELOPMENT*` exists, with at least 300 characters (`min_chars`, which already exists). A "Build" heading is not checked in this version.

**Not applicable:** topics `docs` or `template`.

**Script:** `lint_repos`.

**Issue:** lint issue.

**Limits of the check:** only the file is checked, not whether it describes the build. Correctness of the instructions is the project team's responsibility.

**Preventive:** `create_repos` adds the template to new repositories. **(New capability:** today `create_repos` creates empty repositories; adding a file requires a commit through the API.)

**Rollout:** announce first, then a grace period before the check is switched on.

**New work:**
- topic-based applicability;
- the template.

---

### BR.02 · Unique, increasing version identifiers · MUST

> All releases and released software assets intended for use MUST be assigned unique, monotonically increasing version identifiers.

**Implementation:** Releases are tagged with SemVer (or CalVer). Tags are unique by construction in git. A weekly check confirms that release versions increase.

**Exact check:** `lint/versioning`, on the releases of the last 12 months (`GET /repos/{o}/{r}/releases`):
- Every tag parses as SemVer or CalVer (an optional `v` prefix is allowed).
- Within each major version line, versions increase with release date. This allows backport releases on older lines, as the TR note ("within a branch") describes.
- Pre-releases are included.

**Applies to:** releasing repositories.

**Script:** `lint_repos`. The releases call is shared with BR.04.

**Issue:** lint issue.

**New work:** the releases call, the version parsing, the check.

---

### BR.03 · Integrity of distributed assets verifiable · MUST (+ MAY)

> All assets MUST be distributed in a way that maintains integrity or at least allows its verification. Means to maintain and verify authenticity MAY be deployed.

**Implementation**
- **Source archives:** GitHub generates them from the tag and serves them over HTTPS. That is integrity by construction.
- **Release assets:** built by the OSPO release workflow template, which adds SHA-256 checksums and a GitHub artifact attestation. The attestation is signed, so it also covers the MAY part (authenticity).

**Exact check:** `scorecard/signed-releases` ≥ 8 (provenance gives 10). **(verify** how Scorecard scores releases without uploaded assets: these should count as `na`, because only source archives exist.)

**Applies to:** releasing repositories with uploaded release assets.

**Script:** `scorecard_check`.

**Issue:** Scorecard issue, label `scorecard/signed-releases`.

**Limits of the check:** packages published to registries (npm, Maven Central) are not covered by Signed-Releases. Registry provenance (e.g. npm provenance) could be a later check.

**Prerequisite:** the OSPO release workflow template. Without it, projects cannot fix the finding.

**New work:** the template, the Scorecard threshold.

---

### BR.04 · Change log per release · MUST

> All releases MUST provide a descriptive log of functional and security modifications.

**Implementation:** Every GitHub release has release notes. The release template enables generated release notes, grouped by labels such as `security` (`.github/release.yml`).

**Structural check:** `lint/release-notes`. Every release of the last 12 months has a release body of at least 50 characters, or the repository's `CHANGELOG*` mentions the version.

**Applies to:** releasing repositories.

**Script:** `lint_repos` (shares the releases call with BR.02).

**Issue:** lint issue.

**Limits of the check:** whether the notes describe all functional and security changes cannot be checked.

**New work:** the check, plus a release-notes configuration in the template.

---

### BR.05 · Source packages match the repository · MUST

> Released source packages MUST NOT contain any content that is not present in the project's repository or cannot be deterministically generated from it.

**Implementation**
- **Source packages:** the GitHub-generated archives of the tag. They contain exactly the repository content at that tag.
- **Built packages:** produced by the release workflow from the tagged commit. The artifact attestation (BR.03) links each asset to that commit.

**By construction:** for GitHub-generated source archives.

**Covered by BR.03:** for built assets, through the attestation.

**Check:** `by-construction/source-archives`, a check of the virtual tool `by-construction` (1.5): always `pass`, one per active repository. GitHub generates source archives from the tag, so they always match the repository content; there is nothing to test. It adds one passing result per active repository to the compliance %.

**Limits:** source tarballs uploaded by hand as release assets are not covered. The release template removes the need for them.

**New work:** the `by-construction` results in `compliance_report` (trivial).

> Differs from the mock-up: the mock-up used Scorecard Binary-Artifacts. That check finds binaries *in the repository*, which is a different question, so it is dropped here.

---

### BR.06 · Builds reproducible · SHOULD

> Builds SHOULD be reproducible.

**Not verifiable** at portfolio scale → status "Not assessed", not counted. Reassessed once BR.03 is met.

**New work:** none.

---

### VM.01 · Security contact and private reporting · MUST + SHOULD

> The project documentation MUST contain security contacts for reporting vulnerabilities. There SHOULD be a way to do so privately.

**Implementation:** An organisation-wide `SECURITY.md` in `allianz/.github` applies to every repository without its own. It names the OSPO as contact and asks for private vulnerability reporting, which is enabled on every repository.

**Exact check:** `scorecard/security-policy` = 10, for all repositories. Scorecard finds a `SECURITY.md` in the repository or, if there is none, the org default in `allianz/.github`, and scores its content: linked content (contact), disclosure text, free text. Observed on real data: yukimi scores 10 through `allianz/.github/SECURITY.md`. A repository with its own policy that names no contact scores lower and fails. **(verify** the scoring of a repository's own policy without disclosure text.)

**Script:** `scorecard_check`.

**Issue:** Scorecard issue, label `scorecard/security-policy`.

**SHOULD clause (private reporting):** not assessed in this version (see 1.7). Private vulnerability reporting is still enabled through the `ospo-managed` security configuration. Neither the security configuration nor individual repositories are checked for it.

**New work:** the threshold in `scorecard_check`.

---

### VM.02 · Vulnerabilities published in reasonable time · MUST

> The project MUST publish information about discovered vulnerabilities within a reasonable period of time.

**Implementation:** Vulnerabilities reported privately are triaged by the project team and the OSPO, and published as a GitHub Security Advisory with a CVE, within 90 days of the report.

**Exact check:** `advisories/published-in-time`, one result per active repository. Only public information is used: the published advisories of the repository (`GET /repos/{owner}/{repo}/security-advisories?state=published`).
- `pass` if every advisory published in the last 12 months was published within 90 days of its creation (`published_at` − `created_at`), or if there is none.
- `fail` if at least one took longer. A late publication therefore counts for 12 months.
- `reason` names each advisory and its days to publication, e.g. "1 advisory published in the last 12 months: GHSA-7q4x-2m9c-h3vf after 18 days".

**Script:** `advisories_check` (new, separate for now).

**Issue:** none. A failure is a past event that the project team cannot fix any more; it disappears after 12 months.

**Limits of the check:** advisories in `triage` or `draft` and closed ones are not public and are not counted, so an advisory that is never published never fails the check. Whether `created_at` is the time of the private report **(verify)**. Vulnerabilities reported through other channels (e.g. email to the OSPO) are only measured from the moment an advisory is created. The process statement covers this: every report becomes an advisory.

**New work:** the advisories call per repository, the check.

---

### DE.01 · Discontinuation communicated · SHOULD

> Discontinuation of the project, parts of it, or specific versions or version ranges SHOULD be communicated adequately.

**Implementation:** Every active repository is checked for activity in each weekly run. Repositories without activity for 12 months get a public notice issue (`warn_after: "1 years"`). After 60 more days (`grace_period: "60 days"`) without activity they are archived and leave the scope. The notice issue stays visible on the archived repository, and GitHub marks the repository as archived and read-only.

**What is verified:** that the process covers every repository in scope, not each individual notice. A repository the process does not check could go unmaintained without anyone noticing; a repository it checks is either active or on its way to archival with a notice. Archived repositories are out of scope (1.2) and have no result.

**Exact check**
- `archive/activity-checked` (`archive_repos`): one result per active repository. `pass` if `archive_repos` read the repository's last activity in this run; the `reason` states the last push and, if one is open, the notice issue and the archival date. An active repository that `archive_repos` skips (`excluded_repos`) gets a `fail` from `compliance_report` (1.10 step 4); one it could not evaluate is listed under `errors`.

**Script:** `archive_repos`: adds `--json` with one `archive/activity-checked` result per repository it evaluated. It needs no history and no new API calls: it already reads the last push of every repository.

**Issue:** none. `archive_repos` itself never fails the check; a failure is a configuration matter for the OSPO (`fix` names it).

**Limits:** discontinued *versions* (end of life of a major line) are not covered. That is a project decision and not detectable. Whether the notice was given before an archival is not checked: archival only happens through the notice process, and an archived repository is out of scope either way.

**New work:** `--json` in `archive_repos` (small).

---

### DE.02 · Migration paths outlined · MAY

> If the project, parts of it, or specific versions are discontinued, migration paths MAY be outlined, for example by naming a successor project or a maintained alternative and describing how users can move to it.

**Currently not done, status `not-assessed`.** We will revisit this requirement once the open source programme is more mature.

**New work:** none.

