# Spec: releases_check implementation

## Motivation

Releases must carry unique, monotonically increasing version identifiers (BSI TR-03185 BR.02) and a descriptive log of their functional and security changes (BR.04). Both can be read from the GitHub releases of a repository. This script checks them for every repository and writes the results for the compliance report.

## Scope

The script:

- lists the repositories of the organisation;
- reads the GitHub releases of every active repository, and the `CHANGELOG*` file in its root where a release body is too short;
- writes two results per active repository to the JSON file: [Versioning](#versioning) and [Release Notes](#release-notes).

JSON only. Out of scope:

- Issues. Findings are shown in the compliance report only. The script never opens, updates or closes an issue.
- Any other change on GitHub. The script only reads.
- Draft releases. They are not published.
- Git tags without a GitHub release, and packages published to registries (npm, Maven Central).

---

## CLI Interface

```
node scripts/releases_check.js --org <org> --json <file> [--config <file>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization whose repositories are checked |
| `--json` | required | Write the results to this file, see [JSON output](#json-output). The file is the only product of the script |
| `--config` | `config/releases_check.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes |
| `--debug` | false | Also print the lookback cutoff, passing checks and the repositories without releases |

Exit codes: `0` on success, `1` on missing `--org` or `--json`, missing token, invalid config, or fatal error (any API error other than a 404 on the releases of a repository or on its root contents, see [JSON output](#json-output)).

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment. The token needs read access to the repositories' contents (releases and files). The default config path is resolved relative to the repo root, not the working directory.

---

## Configuration File

```yaml
# Repos to skip. Keep this empty: the compliance report counts a skipped
# repository as failing these checks.
excluded_repos: []

# Releases published within this period are checked.
lookback: "12 months"

# Minimum length of a release body to count as release notes.
min_notes_chars: 50
```

| Field | Required | Description |
|---|---|---|
| `excluded_repos` | no (default `[]`) | Repository names without results |
| `lookback` | no (default `"12 months"`) | `"<N> <unit>"`, unit `day(s)`, `month(s)` or `year(s)` |
| `min_notes_chars` | no (default `50`) | Positive integer |

### Validation

- `min_notes_chars` that is not a positive integer: `Config field min_notes_chars must be a positive integer (in <file>)`.
- Invalid `lookback`: `Invalid relative date: "<value>"`.

An empty file is valid and uses the defaults.

---

## Run log

A short log for the workflow run. The JSON file holds the results.

```
Active repositories: 4 (archived: 1, excluded: 1)
  mobile-sdk-ios: versioning: version not increasing: v3.0.9 after v3.1.0 in major line 3
  pdf-render-service: release notes: 1 of 2 releases without notes: v1.8.0
Releasing repositories: 3
Findings: 2 repositories

JSON written to out/releases_check.json
```

Only failing checks are listed, one line per repository and check. If none fails, the summary line is `All releases versioned and documented.` A repository whose releases return 404 is listed with the reason of its `errors` entries, and a line `Not readable (in errors): N repositories` follows. With `--debug`, a line `Releases published since <date>, release notes of at least <min_notes_chars> characters` follows the first line, passing checks are listed too, and so are the repositories without releases (`No release in the last 12 months`).

---

## JSON output

The file is in the common JSON format of the compliance report ([draft, section 1.6](compliance_implementation_draft.md#16-common-json-format)). The directory is created if needed. A 404 on the releases of a repository goes to `errors`; any other API error aborts the run, and then no file is written.

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | `releases_check`, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | Always `null`: the script opens no issues |
| `results` | Two rows per active repository whose releases could be read, one per check: `repo`, `check`, `name`, `result` (`pass`, `fail` or `na`), `score` (always `null`), `reason` (always filled), `details` |
| `catalogue` | One entry per check: `name` and `documentation` (`url` to the heading below, pinned to `ospo_sha`; `short` rule; `fix`) |
| `skipped` | Repositories without results: `repo` and `reason` (`archived` or `excluded_repos`) |
| `errors` | Two rows (one per check) per repository whose releases returned 404: `repo`, `check`, `reason` ("Releases not readable (request returned 404: private repository or missing permission)"). The report treats it as "no data", never as `pass` |

Results are sorted by repository name, then in the order of the table below.

| Check ID | Name |
|---|---|
| `releases/versioning` | Versioning |
| `releases/release-notes` | Release Notes |

Both checks look at the same releases: those published within `lookback`, not drafts, ordered by `published_at`. Data source: `GET /repos/{owner}/{repo}/releases`. A repository without such a release is not a releasing repository: both checks are `na` with the reason "No release in the last 12 months".

### Versioning

Every release has a SemVer or CalVer tag, and within each major version line every release has a higher version than all releases of that line published before it.

- A tag is an optional `v`, two or three numeric parts, an optional pre-release (`-rc.1`) and optional build metadata (`+build.5`): `v1.4.2`, `2026.11`, `2026.11.0-rc.1`. A missing third part counts as `0`. Anything else (`nightly`, `release-5`, `V1.2.3`) fails.
- The major version line is the first number (for CalVer, the year). Versions are compared by SemVer precedence: pre-releases count and come before their release, build metadata is ignored. Releasing an older major line later (a backport, e.g. `v1.9.4` after `v2.0.0`) passes; releasing `v3.0.9` after `v3.1.0` fails, and so does the same version under two tags (`1.0.0` and `v1.0.0`).
- `reason` on pass: "3 releases follow SemVer or CalVer, increasing within each major line". On failure it names the tags that do not parse ("1 of 4 releases not SemVer or CalVer: nightly") and the steps backwards ("version not increasing: v3.0.9 after v3.1.0 in major line 3"), separated by `; `.
- `details`: `Info: releases checked: <tags in publication order>`, then one `Warn:` line per invalid tag or step backwards, with publication dates.

Limits: version lines across major versions are not compared, so a jump back to an older major line passes. Git tags without a release are not checked; git itself guarantees that tag names are unique.

How to fix: project team: tag releases with SemVer or CalVer (e.g. v1.4.2) and keep versions increasing within each major line. A release that breaks the rule counts for `lookback` unless its tag is corrected.

### Release Notes

Every release has release notes: a release body of at least `min_notes_chars` characters (after trimming whitespace), or a `CHANGELOG*` file in the repository root that mentions its version.

- The changelog is read only if at least one release body is too short. The first file in the root whose name starts with `changelog` (case-insensitive, sorted by name) is used. Without such a file, or if the repository has no contents (404), only the release bodies count.
- A version is mentioned if the changelog contains it with or without `v`, and not as part of a longer version: `2.4.1` does not match `2.4.10` or `2.4.1-rc.1`.
- `reason` on pass: "All 3 releases have notes (release body)", or "(release body or CHANGELOG.md)" when the changelog was needed. On failure: "1 of 2 releases without notes: v1.8.0".
- `details` has one line per release: `Info: v2.3.0 release body (812 characters)`, `Info: v2.4.0 mentioned in CHANGELOG.md`, or `Warn: v1.8.0 release body has 0 characters (minimum 50), no CHANGELOG file`.

Limits: only the length of the notes is checked, not whether they describe all functional and security changes. A changelog that mentions the version passes, whatever it says about it.

How to fix: project team: describe the functional and security changes in the GitHub release (or let GitHub generate the notes), or list the version in CHANGELOG.md. Editing an existing release fixes the finding.
