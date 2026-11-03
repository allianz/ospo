# DRAFT: BSI TR-03185 Chapter 2 implementation plan

Temporary working document, not meant to be kept. It lists every requirement of BSI TR-03185 v1.1.1 Chapter 2 and how it will be implemented and verified. Items marked **(verify)** are assumptions about GitHub or Scorecard behaviour that must be confirmed before implementation.

---

## Part 1: Shared rules

Every requirement entry in Part 2 uses these rules. If an entry seems to contradict them, the rules win and the entry needs fixing.

### 1.1 Verification types

Every check has exactly one type:

| Type | When to use | What proves it |
|---|---|---|
| **Enforced** | Set centrally; project teams cannot change it | `org_snapshot` saves the setting every run and compares it with the expected value and with the previous run |
| **Exact check** | Can change per repository, and the condition can be tested precisely | A per-repository check with a clear pass/fail |
| **Structural check** | Can change per repository, but only the form can be tested, not the content | A per-repository check, plus a "Limits of the check" note on the card |
| **By construction** | GitHub guarantees it; there is nothing to check | A statement in the implementation text |
| **Attestation** | Cannot be read through any API | A signed statement, renewed on change and at least yearly |
| **Not verifiable** | No practical way to verify (SHOULD only) | An approved deviation with an expiry date |

Rule: a MUST can never rely on **Not verifiable**. Deviations are only allowed for SHOULD.

### 1.2 Scope and applicability

- **In scope:** all active (not archived) repositories of the organisation, except `excluded_repos` in `config/compliance_report.yaml`. Each exclusion needs a deviation entry with an expiry date.
- **Archived repositories:** only DE.01 and DE.02 apply. Other checks may report them for information, without issues.
- **Not applicable by topic:** repositories tagged `docs` or `template` have no software to build or test. BR.01 and QA.04 do not apply to them.
- **Releasing repositories:** repositories with at least one GitHub release in the last 12 months. BR.02–BR.05 only apply to these.
- **Not applicable by data:** when a check has no data to judge (e.g. Scorecard "inconclusive" because there were no pull requests), the result is `na`, not `pass`.

### 1.3 Scripts and their roles

Every checking script works the same way: it **runs its checks, owns its issues, and writes a JSON result**. The report script only reads JSON files. It never changes anything on GitHub.

| Script | Status | Role |
|---|---|---|
| `create_repos.js` | exists | Preventive: provisions repositories, teams, security configuration, ruleset targets. With `--dry-run --json`: drift check. |
| `lint_repos.js` | exists, extend | Per-repository checks on repository data and the cloned content |
| `license_scan.js` | exists, extend | SBOM retrieval and dependency licenses |
| `archive_repos.js` | exists, extend | Inactivity notices and archival |
| `org_snapshot.js` | **new** | Saves org settings, ruleset, security configurations, org security policy and security advisories. Compares them with expected values. No issues. |
| `scorecard_check.js` | **new** | Reads Scorecard results from the public API, applies thresholds, opens and closes issues |
| `compliance_report.js` | **new** | Merges all JSON results, maps checks to requirements, computes statuses, renders HTML, Markdown and `data.json` |

### 1.4 Weekly workflow

One workflow, `compliance.yaml`, runs every week and replaces the separate schedules of `lint_repos`, `license_scan` and `archive_repos`:

```
lint_repos      ─┐
license_scan    ─┤
archive_repos   ─┤
create_repos    ─┼─▶ compliance_report ─▶ release compliance-YYYY-MM-DD
  (--dry-run)    │                         (report.html, data.json, all JSON inputs)
org_snapshot    ─┤
scorecard_check ─┘
```

- Each job uploads its JSON as an artifact. The report job runs `if: always()`, and a missing input means "no data", never "pass".
- The report job downloads the previous release's `data.json`, which carries trend history and "failing since" dates.

### 1.5 Check IDs, issues and labels

- **Check IDs** have the form `<tool>/<check>`, e.g. `lint/contributing`, `scorecard/ci-tests`.
- **Requirement mapping** exists in one place only: `config/compliance_report.yaml`. The scripts know nothing about BSI IDs.
- **Issues:** each tool keeps one issue per repository, as `lint_repos` does today. That issue lists all failing checks of that tool.
- **Labels:** the issue carries one label per failing check, e.g. `lint/contributing`. Labels are added and removed as checks change. The report's "Live issues" link searches by label, e.g. `org:allianz is:issue is:open label:lint/contributing`.
- **Security-sensitive results never become public issues.** For example: an unpublished advisory, or a repository with secret scanning switched off. The OSPO is notified privately, and the public report shows counts only.
- **Issues disabled:** a check cannot open an issue in a repository whose issues are switched off (QA.03). Such findings go to the OSPO instead.

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
    { "repo": "foo", "check": "lint/contributing", "result": "pass",
      "detail": null, "evidence": { "file": ".github/CONTRIBUTING.md" } }
  ]
}
```

- `result` is one of `pass`, `fail` or `na`.
- `evidence` records *what* was found, so an auditor can verify a sample by hand.

### 1.7 Status logic (computed by the report)

Per requirement part:

- **Met:** all applicable repositories pass.
- **Met, with tracked findings:** some fail, but every failure has an open issue (or an OSPO notification), and none is older than its target.
- **Not met:** at least one failure is older than its target, or untracked, or the enforced setting deviates from its expected value.
- **Not verified:** no check covers this part. For SHOULD, this must link to a deviation. For MUST, it is a gap and counts as Not met.
- **Not applicable / Optional:** no applicable repositories, or a MAY requirement.

Overall requirement status = the worst MUST part. SHOULD parts are shown separately.

- **Targets:** 90 days by default, overridable per check in the config.
- **Failing since:** the date a repository × check pair first failed. It is carried forward from the previous `data.json`, and resets when the check passes.

### 1.8 Configuration of the report

```yaml
# config/compliance_report.yaml
excluded_repos:
  - name: ng-aquila
    deviation: D-03

targets:
  default_days: 90

requirements:
  GV.01:
    implementation: >
      Every repository must contain a contribution guide …
    parts:
      - level: MUST
        checks: [lint/contributing]
      - level: SHOULD
        checks: []
        gap: >
          The check confirms that the file exists, not whether it describes the
          expected quality of contributions.
        deviation: D-04

deviations:
  - id: D-04
    requirement: GV.01
    scope: SHOULD part, all repositories
    justification: …
    approved_by: Head of OSPO
    valid_until: 2027-03-31

actions:
  - id: R-07
    requirement: GV.01
    action: …
    owner: OSPO
    due: 2027-03-31
```

- Deviations and remediation actions are data, so the report can flag expired deviations and overdue actions.
- Every change to this file goes through a PR, which gives the audit trail.

### 1.9 Attestations

A manual attestation is a Markdown file added by pull request, e.g. `attestations/2026-10-15-identity.md`. The ISO or the Head of OSPO approves the PR, and that approval is the signature. The report reads the date of the latest attestation and flags it when it is older than 12 months.

---

## Part 2: Requirements

### GV.01 · How to contribute is documented · MUST + SHOULD

> Information on how to contribute to the project MUST be documented. Information about the expected quality of contributions SHOULD be given.

**Implementation:** Every repository must contain a contribution guide (`CONTRIBUTING` file in the root, `.github` or `docs`). An automated check runs every week and opens an issue in any repository that lacks one, until it is fixed.

**MUST part**
- **Check:** `lint/contributing`, a structural check. A file `CONTRIBUTING*` exists in `.`, `.github` or `docs`.
- **Script:** `lint_repos` (exists).
- **Issue:** lint issue, label `lint/contributing`.
- **Evidence:** the file path found.

**SHOULD part**
- **Not verified for now** → deviation D-04.
- **Later (R-07):** a structural check `lint/contributing-sections`, requiring headings for coding standards, tests and review. It uses the same heading-check mechanism as BR.01.

**New work:** labels and `--json` only. The check itself already exists.

---

### GV.02 · Protected against unauthorised actions · MUST

> The project's repository, websites and sensitive data MUST be protected against unauthorized actions.

**Implementation**
- **Repository:** Changes need a company account with SSO and MFA. Only teams get access, synced with Entra ID. Every permission change is a pull request and is approved first. An org ruleset protects the default branches.
- **Websites:** published with GitHub Pages only, so the repository's access rules apply.
- **Sensitive data:** secret scanning and push protection are on for every repository.

**Enforced**, via `org_snapshot`, compared with expected values:
- **Org settings** (`GET /orgs/{org}`): 2FA required, base permission, members cannot create repositories.
- **Ruleset `ospo-managed`** (`GET /orgs/{org}/rulesets/{id}`): pull request required, no force-push, no deletion.
- **Security configuration `ospo-managed`** (`GET /orgs/{org}/code-security/configurations`): secret scanning and push protection enabled, enforced.

**Exact checks**
- `lint/no-direct-collaborators`: no user has direct access, only teams (`GET /repos/{o}/{r}/collaborators?affiliation=direct`). **(verify** that org owners are not listed.)
- `lint/secret-scanning`: for repositories with `security: custom`, secret scanning and push protection are on. Reads the repo's `security_and_analysis` field. **(verify** the App permission needed to see this field.)
- `scorecard/branch-protection`: for repositories with `branch-protection: custom`, Scorecard Branch-Protection ≥ 6. `scorecard_check` reads `config/create_repos.yaml` to know which repositories are custom.
- `scorecard/dangerous-workflow` = 10 and `scorecard/token-permissions` ≥ 8, for all repositories.
- `drift/access`: `create_repos --dry-run --json` plans no changes.

**Attestation:** SSO enforcement, MFA and Entra ID team sync (`attestations/*-identity.md`), at least yearly.

**Websites:** no check. The scope statement "GitHub Pages only" is in the implementation text.

**Issues**
- `lint/no-direct-collaborators` and the Scorecard checks: public issue.
- `lint/secret-scanning`: OSPO notification only (security-sensitive).
- Drift and snapshot deviations: OSPO notification. These are central settings, so there is no repository issue.

**New work:** `org_snapshot`, the two lint checks, the `scorecard_check` thresholds, `create_repos --json`, and the first attestation file.

---

### LE.01 · License stated for all content · MUST

> A license MUST be stated for all content made available by the project, including the project's documentation.

**Implementation:** Every repository must contain a license file with an approved license (Apache-2.0, MIT, CC-BY-4.0, CC0-1.0). The license file in the root applies to all content of the repository, including documentation and the Pages website, unless a file states otherwise. A weekly check opens an issue if the license is missing or not approved.

**Exact checks**
- `lint/license-file`: a file `LICENSE*` exists in the root.
- `lint/license-type`: the SPDX ID detected by GitHub is on the approved list. `NOASSERTION` fails.

**Script:** `lint_repos` (exists).

**Issue:** lint issue, labels as above.

**Archived repositories:** checked for information, no issues (the existing behaviour).

**Exclusions:** ng-aquila (D-03).

**New work:** labels and `--json` only.

---

### LE.02 · Licenses of all components referenced · MUST

> A copy of all licenses in use, or references hereto, MUST be provided.

**Implementation:** For every repository, a public SPDX SBOM is available from the dependency graph. It lists every declared dependency with its license identifier, which is a reference to the license text. The project's own license is covered by LE.01.

**Exact check**
- `sbom/available`: the SBOM can be retrieved for the default branch. This is the same check as QA.01.

**For information, no issue**
- The share of components without license information (`NOASSERTION`) per repository.
- Projects usually cannot fix missing license metadata of upstream packages, so an issue would be noise.

**Script:** `license_scan` (extend).

**Limits of the check:** components not declared through a package manager (copied-in code) are not in the SBOM.

**Not part of the TR:** the deny list for dependency licenses (the existing `license_scan` issue) is internal policy. It stays in place but is not mapped to a requirement.

**New work:** record `sbom/available` per repository and the `NOASSERTION` share, plus `--json`.

> Differs from the mock-up: LE.02 becomes "Met" based on SBOM availability. The `NOASSERTION` share is information only.

---

### QA.01 · List of third-party components available · MUST

> A list of third-party components used in the software MUST be available.

**Implementation:** The dependency graph is enabled for every repository through the security configuration. Its SPDX SBOM is the public list of third-party components.

**Enforced:** dependency graph enabled in the `ospo-managed` security configuration (`org_snapshot`).

**Exact check:** `sbom/available` (shared with LE.02).

**Issue:** `license_scan` issue, label `sbom/available`. Today `license_scan` opens issues only for denied licenses; it must also open one when the SBOM is missing.

**Limits of the check:**
- Components that are not declared through a package manager are not listed.
- There is no SBOM per release. That is optional: the release template (R-01, see BR.03) could attach one.

**New work:** a failure path in `license_scan`, plus labels.

---

### QA.02 · Source code publicly readable · MUST

> All of the project's source code MUST be publicly readable.

**Implementation:** All repositories are created by the provisioning pipeline as public. Members cannot create repositories.

**Enforced:** "members cannot create repositories" (`org_snapshot`).

**Exact check:** `lint/public`. The visibility of every in-scope repository is `public`.

**Script:** `lint_repos`. The data is already in the repository list, so no extra call is needed.

**Issue:** OSPO notification. A private repository is not readable by the public, so a public issue makes no sense, and making a repository private is a central action anyway.

**New work:** one small check.

---

### QA.03 · How to report defects is communicated · MUST

> The project MUST inform how to report defects.

**Implementation:** Issues are enabled on every repository, and project teams cannot disable them. Security defects are reported privately (VM.01).

**Exact check:** `lint/issues-enabled`, i.e. `has_issues == true`.

**Issue:** not possible when issues are disabled → OSPO notification.

**For information:** whether issue templates exist. No status impact.

**New work:** one small check.

---

### QA.04 · Testing procedures implemented and used · MUST

> Procedures for testing MUST be implemented and utilised.

**Implementation:** Every repository with code tests its changes automatically in CI. `DEVELOPMENT.md` describes how to run the tests locally. A weekly check opens an issue when CI did not run on recently merged pull requests.

**Implemented**
- **Structural check:** `lint/development-test`. `DEVELOPMENT.md` has a "Test" heading. This is a separate check from BR.01's `lint/development-build`, so a missing "Build" heading does not fail QA.04.

**Utilised**
- **Exact check:** `scorecard/ci-tests` ≥ 8. Scorecard "inconclusive" (no merged pull requests) → `na`.

**Not applicable:** topics `docs` or `template`.

**Scripts:** `lint_repos` and `scorecard_check`.

**Issues:** lint issue; Scorecard issue, label `scorecard/ci-tests`.

**Limits of the check:** Scorecard detects that CI ran, not what it tested.

**New work:** comes with BR.01 and `scorecard_check`.

---

### QA.05 · Memory safety issues reduced · SHOULD

> The project SHOULD take measures to reduce or avoid memory safety issues.

**Implementation:** Projects use memory-safe languages. Projects that contain C, C++, Objective-C or assembly use fuzzing or sanitizers, and describe this in `DEVELOPMENT.md`. Code scanning (CodeQL) runs on every repository through the security configuration.

**Applicability:** repositories whose languages (`GET /repos/{o}/{r}/languages`) include a non-memory-safe language with more than 5% of the code. All others are not applicable, because the language choice itself is the measure.

**Structural check:** `lint/memory-safety-section`. `DEVELOPMENT.md` has a "Memory safety" heading that describes the measures (fuzzing, sanitizers, …). Only `lint_repos` opens issues for QA.05.

**For information:** `scorecard/fuzzing`. It is reported without issues, because one check per requirement owns the issue; otherwise two tools would open issues for the same gap.

**Enforced:** code scanning enabled in the security configuration (`org_snapshot`). **(verify** that code scanning is part of `ospo-managed`.)

**Scripts:** `lint_repos` (languages, heading); `scorecard_check` for information only.

**Issue:** yes, it is a SHOULD with a clear action.

**New work:** the language lookup and the heading check (same mechanism as BR.01).

---

### QA.06 · Changes peer-reviewed · SHOULD

> All changes to the source code SHOULD be peer-reviewed.

**Implementation:** The org ruleset requires a pull request with at least one approval before merging into the default branch.

**Enforced:** the ruleset requires approvals ≥ 1 (`org_snapshot`). **(verify** whether `ospo-managed` requires approvals today.)

**Exact check:** `scorecard/code-review` ≥ 7, for all repositories. It confirms the effect, including repositories with custom branch protection and admin bypasses.

**Single-maintainer projects:** a required approval would block them. Each such project needs a deviation (like D-02) until it has a second maintainer, which is a policy decision.

**Script:** `scorecard_check`.

**Issue:** Scorecard issue, label `scorecard/code-review`.

**New work:** the Scorecard threshold, and the policy decision.

---

### BR.01 · Build information public · MUST

> Information on how to build all software assets MUST be publicly available.

**Implementation:** Every repository with code contains `DEVELOPMENT.md` (in the root, `docs` or `.github`) describing how to build and test it. The OSPO standards guide defines the required sections. New repositories get a template.

**Structural checks**
- `lint/development-file`: `DEVELOPMENT*` exists, with at least 300 characters (`min_chars`, which already exists).
- `lint/development-build`: the file has a "Build" heading. (The "Test" heading is `lint/development-test`, used by QA.04.)

**Not applicable:** topics `docs` or `template`.

**Script:** `lint_repos`.

**Issue:** lint issue.

**Limits of the check:** correctness of the instructions is the project team's responsibility.

**Preventive:** `create_repos` adds the template to new repositories. **(New capability:** today `create_repos` creates empty repositories; adding a file requires a commit through the API.)

**Rollout:** announce first, then a grace period before the check is switched on.

**New work:**
- the heading check in `lint_repos` (generic: `required_headings` on a `required_files` entry);
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
- **Release assets:** built by the OSPO release workflow template (R-01), which adds SHA-256 checksums and a GitHub artifact attestation. The attestation is signed, so it also covers the MAY part (authenticity).

**Exact check:** `scorecard/signed-releases` ≥ 8 (provenance gives 10). **(verify** how Scorecard scores releases without uploaded assets: these should count as `na`, because only source archives exist.)

**Applies to:** releasing repositories with uploaded release assets.

**Script:** `scorecard_check`.

**Issue:** Scorecard issue, label `scorecard/signed-releases`.

**Limits of the check:** packages published to registries (npm, Maven Central) are not covered by Signed-Releases. Registry provenance (e.g. npm provenance) could be a later check.

**Prerequisite:** the release workflow template (R-01). Without it, projects cannot fix the finding, and the status stays Not met.

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

**Check:** none of its own.

**Limits:** source tarballs uploaded by hand as release assets are not covered. The release template removes the need for them.

**New work:** none beyond BR.03.

> Differs from the mock-up: the mock-up used Scorecard Binary-Artifacts. That check finds binaries *in the repository*, which is a different question, so it is dropped here.

---

### BR.06 · Builds reproducible · SHOULD

> Builds SHOULD be reproducible.

**Not verifiable** at portfolio scale → deviation D-01, reassessed once BR.03 is met.

**Optional later:** a yearly self-assessment question (see Part 3).

**New work:** the deviation entry only.

---

### VM.01 · Security contact and private reporting · MUST + SHOULD

> The project documentation MUST contain security contacts for reporting vulnerabilities. There SHOULD be a way to do so privately.

**Implementation:** An organisation-wide `SECURITY.md` in `allianz/.github` applies to every repository without its own. It names the OSPO as contact and asks for private vulnerability reporting, which is enabled on every repository.

**MUST part**
- **Enforced:** `org_snapshot` confirms that `allianz/.github/SECURITY.md` exists and contains a contact. Repositories with their own `SECURITY.md` are recorded for information.

**SHOULD part**
- **Enforced:** private vulnerability reporting is enabled in the `ospo-managed` security configuration (`org_snapshot`). **(verify** that it is part of the configuration.)
- **Exact check:** `lint/private-reporting`, for repositories with `security: custom` (`GET /repos/{o}/{r}/private-vulnerability-reporting`).

**Issue:** lint issue for custom repositories.

**New work:** the snapshot items, plus one lint check.

---

### VM.02 · Vulnerabilities published in reasonable time · MUST

> The project MUST publish information about discovered vulnerabilities within a reasonable period of time.

**Implementation:** Vulnerabilities reported privately are triaged by the project team and the OSPO, and published as a GitHub Security Advisory with a CVE. Target: 90 days from report to publication.

**Exact check:** `advisories/published-in-time`, using the repository advisories of the org (`GET /orgs/{org}/security-advisories`):
- Every advisory in `triage` or `draft` that is older than 90 days fails.
- Published advisories record their days to publication.

**Script:** `org_snapshot`.

**Issue:** never public, because these are unpublished vulnerabilities. OSPO notification only. The public report shows counts and the median time.

**Limits of the check:** vulnerabilities reported through other channels (e.g. email to the OSPO) are only visible once an advisory is created. The process statement covers this: every report becomes an advisory.

**New work:** the advisories call, the check, the private notification.

---

### DE.01 · Discontinuation communicated · SHOULD

> Discontinuation of the project, parts of it, or specific versions or version ranges SHOULD be communicated adequately.

**Implementation:** Repositories without activity for 12 months get a public notice issue (`warn_after: "1 years"`). After 60 more days (`grace_period: "60 days"`) they are archived. The notice issue stays visible on the archived repository, and GitHub marks the repository as archived and read-only.

**By construction:** `archive_repos` only archives after the grace period. Every archival it performs therefore had a notice of at least 60 days. Its JSON records each archival as the evidence.

**Exact check:** `archive/notice-before-archival` for repositories archived *outside* the process. This needs two runs to compare, so `compliance_report` does it, not `archive_repos`:
- a repository that was active in the previous `data.json`,
- is archived now,
- and was not archived by `archive_repos`
→ fail, "archived outside the process". GitHub does not record when a repository was archived **(verify)**, so the date is "between the previous run and this run".

**Scripts**
- `archive_repos`: adds `--json` with the archivals it performed in this run (notice issue, notice date, archival date). It needs no history and no new API calls: it already reads the warning issue's `created_at` before archiving.
- `compliance_report`: does the comparison with the previous run, and carries an `archivals` list forward for 12 months (it feeds the DE.01 card: "N of M archived in the period had a notice").

**Issue:** none, because the repository is archived. A finding is listed for the OSPO (the existing `Stale Repository Summary` issue in the `ospo` repository is the natural place). It stays open until the OSPO resolves it: either unarchive and go through the process, or accept it with an entry in `config/compliance_report.yaml`.

**Limits:** discontinued *versions* (end of life of a major line) are not covered. That is a project decision and not detectable.

**New work:** `--json` in `archive_repos` (small); the comparison and the `archivals` list in `compliance_report`.

### DE.02 · Migration paths outlined · MAY

> Migration paths MAY be outlined.

**Optional, not assessed.** The notice issue from `archive_repos` asks maintainers to name a successor or alternative in the README before archival.

**New work:** one sentence in the notice issue template.

