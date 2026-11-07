# Spec: scorecard_check implementation

## Motivation

Several BSI TR-03185 requirements are measured with OpenSSF Scorecard: protection against unauthorised actions (GV.02: Branch-Protection, Dangerous-Workflow, Token-Permissions), testing (QA.04: CI-Tests), memory safety (QA.05: Fuzzing), peer review (QA.06: Code-Review), integrity of releases (BR.03: Signed-Releases) and the security contact (VM.01: Security-Policy). This script runs the Scorecard CLI for every repository, converts its output to the common JSON format of the compliance report, and applies the thresholds and the applicability rules of the OSPO.

It writes **all** Scorecard checks, not only the eight mapped to BSI requirements, with Scorecard's `score`, `reason` and `details` unchanged, plus the overall score per repository. The BSI report uses only some of this; the rest is kept for a separate Scorecard report.

## Scope

The script:

- lists the repositories of the organisation;
- runs `scorecard --repo=github.com/<org>/<repo> --format=json --show-details` for every active repository;
- reads the languages of every scanned repository (for Fuzzing) and the `branch-protection` setting from the create_repos configuration (for Branch-Protection);
- writes one result per configured check and active repository to the JSON file, see [JSON output](#json-output).

JSON only. Out of scope:

- Issues. Findings are shown in the compliance report only. The script never opens, updates or closes an issue.
- Any other change on GitHub. The script only reads.
- The public Scorecard API (`api.scorecard.dev`). It only has results for repositories that publish them with the Scorecard Action.

---

## CLI Interface

```
node scripts/scorecard_check.js --org <org> --json <file> [--config <file>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization whose repositories are checked |
| `--json` | required | Write the results to this file, see [JSON output](#json-output). The file is the only product of the script |
| `--config` | `config/scorecard_check.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes |
| `--debug` | false | Also print the number of repositories with managed branch protection, and passing and not applicable checks |

Exit codes: `0` on success, `1` on missing `--org` or `--json`, missing token, invalid config, a missing Scorecard CLI, a Scorecard version other than `scorecard_version`, or fatal error (any API error other than a 404 on the languages of a repository). A repository that Scorecard cannot scan does not stop the run: it goes to `errors`.

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment. It is passed to the Scorecard CLI as `GITHUB_AUTH_TOKEN`. The token needs read access to the repositories. The Scorecard CLI must be installed in the pinned version: `scorecard` on the `PATH`, or the path in `SCORECARD_BIN`. The default config path is resolved relative to the repo root, not the working directory.

---

## Configuration File

```yaml
excluded_repos: []
scorecard_version: v5.6.0
concurrency: 3
create_repos_config: config/create_repos.yaml
not_applicable_topics: [docs, template]
fuzzing:
  languages: [C, C++, Objective-C, Objective-C++, Assembly]
  min_share: 5
thresholds:
  Binary-Artifacts: 10
  Branch-Protection: 6
  CI-Tests: 8
  # … one entry per Scorecard check
```

| Field | Required | Description |
|---|---|---|
| `excluded_repos` | no (default `[]`) | Repository names without results. Keep it empty: the compliance report counts a skipped repository as failing these checks |
| `scorecard_version` | yes | Pinned Scorecard CLI version, compared with `GitVersion` of `scorecard version` before any scan |
| `concurrency` | no (default `3`) | Repositories scanned in parallel. Scorecard makes many API calls per repository |
| `create_repos_config` | no (default `config/create_repos.yaml`) | create_repos configuration, relative to the repo root. See [Branch-Protection](#branch-protection) |
| `not_applicable_topics` | no (default `[docs, template]`) | See [CI-Tests](#ci-tests) |
| `fuzzing.languages` | no (default `[C, C++, Objective-C, Objective-C++, Assembly]`) | Non-memory-safe languages, as GitHub names them. See [Fuzzing](#fuzzing) |
| `fuzzing.min_share` | no (default `5`) | Percentage of the code bytes |
| `thresholds` | yes | Minimum score (integer 0–10) per Scorecard check name to pass. **The set of checks written**: a check of the Scorecard output that is not listed is ignored and named in the run log, so a new Scorecard version needs a config update |

### Validation

- Missing `scorecard_version` or `thresholds`: `Config missing required field: <field> (in <file>)`.
- A threshold that is not an integer from 0 to 10: `Threshold of <check> must be an integer from 0 to 10 (in <file>)`.
- `concurrency` that is not a positive integer, `create_repos_config` that is empty, `not_applicable_topics` or `fuzzing.languages` that is not a list of strings, `fuzzing.min_share` outside 0–100: an error naming the field.
- The create_repos configuration is validated like in `create_repos`.

---

## Run log

A short log for the workflow run. The JSON file holds the results.

```
Active repositories: 4 (archived: 1, excluded: 1)
Scorecard v5.6.0 (61e8474)
  broken: not scanned: Scorecard returned no checks (empty repository or no read access)
  mobile-sdk-ios: Branch-Protection 5 (< 6): branch protection is not maximal on development and all release branches
  mobile-sdk-ios: Fuzzing 0 (< 10): project is not fuzzed
  mobile-sdk-ios: SAST: error: internal error: GraphQL timeout
Not configured in thresholds, ignored: Webhooks
Scanned repositories: 3
Findings: 1 repository
Errors: 2 repositories

JSON written to out/scorecard.json
```

Failing checks are listed with score and threshold, one line per repository and check; a `fail` decided by scorecard_check (no score) shows its decision instead. Then one line per repository that could not be scanned and per check in `errors`. If none fails, the summary line is `No findings.`. With `--debug`, a line `Managed branch protection: N repositories (from <create_repos_config>)` follows the version, and passing (`License 10: license file detected`) and not applicable checks (`CI-Tests na: not applicable, topic 'docs'`) are listed too.

---

## JSON output

The file is in the common JSON format of the compliance report ([draft, section 1.6](compliance_implementation_draft.md#16-common-json-format)). The directory is created if needed.

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | `scorecard_check`, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | Always `null`: the script opens no issues |
| `source` | `scorecard CLI (--format=json --show-details)` |
| `scorecard_version`, `scorecard_commit` | Version and commit of the Scorecard CLI (`scorecard version`) |
| `results` | One row per configured check and scanned repository, unless it is in `errors`: `repo`, `check`, `name`, `result` (`pass`, `fail` or `na`), `score`, `reason`, `details` |
| `catalogue` | One entry per configured check: `name`, `threshold` and `documentation` (`url` and `short`, copied from Scorecard's output, so the URL is pinned to the Scorecard commit). No `fix`: the Scorecard documentation explains remediation. For Branch-Protection, CI-Tests and Fuzzing, the applicability rule below is appended to `short`. A check missing from every output links to `docs/checks.md` of `scorecard_commit` |
| `skipped` | Repositories without results: `repo` and `reason` (`archived` or `excluded_repos`) |
| `errors` | Repository × check pairs without a result: `repo`, `check`, `reason`. The report treats them as "no data", never as `pass` |
| `repositories` | One entry per scanned repository: `repo`, `commit` (scanned commit), `date` (of the scan, UTC), `score` (Scorecard's overall score, 0–10). For a Scorecard report; not used by the compliance report |

Results are sorted by repository name, then in the order of `thresholds`. The check ID is `scorecard/` plus the Scorecard name in lower case: `CI-Tests` → `scorecard/ci-tests`.

### Conversion

`name`, `reason` and `details` are copied unchanged from Scorecard; `score` too, except that `-1` becomes `null` and `details: null` becomes `[]`. Checks are matched by `name`, not by position. For each configured check, the first rule that matches decides:

1. **Decisions of scorecard_check**: [Branch-Protection](#branch-protection) on a managed repository, [CI-Tests](#ci-tests) with a not-applicable topic, [Fuzzing](#fuzzing) without a non-memory-safe language: `na`. These need no Scorecard data, so they come before the error rules. Scorecard's score and reason are kept, and the first `details` line explains the decision (`Info: scorecard_check: …`).
2. Score `-1` and a reason starting with `internal error` → `errors`, never `na`.
3. Score `-1` on CI-Tests: see [CI-Tests](#ci-tests).
4. Any other score `-1` (inconclusive, e.g. Signed-Releases "no releases found") → `na`.
5. `score >= threshold` → `pass`, otherwise `fail`.

A configured check missing from the output goes to `errors` (`<check> not in Scorecard output`).

A repository without usable output gets one `errors` row per configured check and no `repositories` entry. That covers output that is not JSON, a non-zero exit without JSON (`Scorecard failed (exit code N): <last line of stderr>`), a timeout after 20 minutes, and `checks: null`, which Scorecard returns for an empty repository (`Scorecard returned no checks (empty repository or no read access)`). Scorecard may exit non-zero after a single check failed; its JSON is used all the same.

### Branch-Protection

Not applicable to repositories with `branch-protection: managed` in the create_repos configuration (the default there): the org ruleset `ospo-managed` protects them, which is documented in GV.02. Details line: `Info: scorecard_check: not evaluated, branch-protection is managed by the org ruleset ospo-managed`. A repository that is not listed in the create_repos configuration is not targeted by the ruleset, so the threshold applies to it.

### CI-Tests

Not applicable to repositories with a topic from `not_applicable_topics`: they have no software to build or test. Details line: `Info: scorecard_check: not applicable, topic 'docs'`.

Scorecard's CI-Tests is inconclusive (`-1`, "no pull request found") when no recent change came through a pull request. That has two causes, told apart through Code-Review's reason:

- `Found x/N approved changesets` with N > 0: changes reached the default branch without pull requests. Result `fail`, details line `Warn: scorecard_check: N changesets reached the default branch without pull requests`.
- `all changesets reviewed`, `no changesets found`, `no changesets detected`, or Code-Review itself `-1`: no changes. Result `na`.
- Code-Review missing, an internal error, or any other wording: `errors`. A new Scorecard wording can therefore not silently turn a `fail` into `na`.

### Fuzzing

Applies only to repositories where a language of `fuzzing.languages` has more than `fuzzing.min_share` percent of the code bytes (`GET /repos/{owner}/{repo}/languages`). For all others, the choice of a memory-safe language is the measure, and the result is `na` with `Info: scorecard_check: not applicable, no non-memory-safe language (C, C++, Objective-C, Objective-C++, Assembly) above 5%` (plus the shares found below the limit, e.g. `(C 3%)`). Where it applies, the first details line names the shares (`Info: scorecard_check: applies, Objective-C 26%, C 3%`) and the threshold decides. A 404 on the languages puts Fuzzing into `errors` (`Languages not readable …`).
