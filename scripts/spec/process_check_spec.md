# Spec: process_check implementation

## Motivation

Some requirements of the compliance report are about how a project handles its releases and its vulnerabilities, not about what the repository contains:

- Vulnerabilities that were reported privately must be published within a reasonable period of time. Every report becomes a GitHub Security Advisory, so the time from its creation to its publication shows whether this happened ([Advisories](#advisories)).
- Releases must carry unique, monotonically increasing version identifiers (BSI TR-03185 BR.02) and a descriptive log of their functional and security changes (BR.04). Both can be read from the GitHub releases of a repository ([Releases](#releases)).
- Some requirements are met by GitHub's own design, not by anything a project team does. For example, GitHub generates the source archives of a release from the tag, and it always enables the dependency graph for public repositories. There is nothing to check, but such a requirement still needs results, so that it has a status, coverage and a card like every other requirement ([By construction](#by-construction)).

This script checks all of them for every repository and writes the results for the compliance report.

## Scope

The script:

- lists the repositories of the organisation;
- reads the **published** security advisories of every active repository (public data only);
- reads the GitHub releases of every active repository, and the `CHANGELOG*` file in its root where a release body is too short;
- writes five results per active repository to the JSON file: [Advisories Published in Time](#advisories-published-in-time), [Source Archives](#source-archives), [SBOM Available](#sbom-available), [Versioning](#versioning) and [Release Notes](#release-notes).

JSON only. Out of scope:

- Issues. Findings are shown in the compliance report only. A late advisory publication is a past event that the project team cannot fix any more; it disappears from the check after `lookback`. The by-construction checks cannot fail. The script never opens, updates or closes an issue.
- Any other change on GitHub. The script only reads.
- Advisories in `triage` or `draft` state and closed advisories. They are not public.
- Draft releases. They are not published.
- Git tags without a GitHub release, and packages published to registries (npm, Maven Central).
- Testing the by-construction guarantees. These checks are not tests; their rule says so.

---

## CLI Interface

```
node scripts/process_check.js --org <org> --json <file> [--config <file>] [--debug]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization whose repositories are checked |
| `--json` | required | Write the results to this file, see [JSON output](#json-output). The file is the only product of the script |
| `--config` | `config/report/process_check.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes |
| `--debug` | false | Also print the lookback cutoffs, passing checks, and the repositories without advisories or releases |

Exit codes: `0` on success; `1` on missing `--org` or `--json`, missing token, invalid config, or fatal error (an error listing the repositories of the organisation, or writing the file); `1` also when the file was written but has [unexpected errors](#errors) in it.

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment. The token needs read access to the repositories' contents (releases and files) and their security advisories **(verify** the GitHub App permission; published advisories of public repositories are public**)**. The default config path is resolved relative to the repo root, not the working directory.

---

## Configuration File

```yaml
# Repos to skip. Keep this empty: the compliance report counts a skipped
# repository as failing every check of this tool.
excluded_repos: []

advisories:
  # Maximum days from creation to publication of an advisory.
  max_days: 90
  # Advisories published within this period are checked.
  lookback: "12 months"

releases:
  # Releases published within this period are checked.
  lookback: "12 months"
  # Minimum length of a release body to count as release notes.
  min_notes_chars: 50
```

| Field | Required | Description |
|---|---|---|
| `excluded_repos` | no (default `[]`) | Repository names without results |
| `advisories.max_days` | no (default `90`) | Positive integer |
| `advisories.lookback` | no (default `"12 months"`) | `"<N> <unit>"`, unit `day(s)`, `month(s)` or `year(s)` |
| `releases.lookback` | no (default `"12 months"`) | `"<N> <unit>"`, unit `day(s)`, `month(s)` or `year(s)` |
| `releases.min_notes_chars` | no (default `50`) | Positive integer |

### Validation

- `advisories` or `releases` that is not a mapping: `Config field <section> must be a mapping (in <file>)`.
- `advisories.max_days` or `releases.min_notes_chars` that is not a positive integer: `Config field <field> must be a positive integer (in <file>)`.
- Invalid `lookback`: `Invalid relative date: "<value>"`.

An empty file is valid and uses the defaults; so does a section with only some of its fields.

---

## Run log

A short log for the workflow run, one block per check family. The JSON file holds the results.

```
Active repositories: 4 (archived: 1, excluded: 1)
Advisories:
  pdf-render-service: 1 of 1 advisory published later than 90 days: GHSA-p2w8-xr6j-9cq4 after 130 days
  pricing-engine: 1 advisory published in the last 12 months: GHSA-7q4x-2m9c-h3vf after 18 days
Late publications: 1 repository
Releases:
  mobile-sdk-ios: versioning: version not increasing: v3.0.9 after v3.1.0 in major line 3
  pdf-render-service: release notes: 1 of 2 releases without notes: v1.8.0
Releasing repositories: 3
Findings: 2 repositories
By construction (always pass): by-construction/source-archives, by-construction/sbom-available

JSON written to results/process_check.json
```

- **Advisories:** only repositories with advisories in the lookback window are listed. If none was late, the summary line is `All advisories published in time.`
- **Releases:** only failing checks are listed, one line per repository and check. If none fails, the summary line is `All releases versioned and documented.`
- A repository whose family could not be read is listed in that block with the reason of its `errors` entries, and a line `Not readable (in errors): N repositories` ends the block. If there were [unexpected errors](#errors), the line `Unexpected errors (in errors): N` comes before the last line, and the exit code is `1`.
- With `--debug`, each block starts with its cutoff (`Advisories published since <date>, at most <max_days> days after creation`, `Releases published since <date>, release notes of at least <min_notes_chars> characters`), and every repository is listed: passing checks, `No advisory published in the last 12 months`, `No release in the last 12 months`.

---

## JSON output

The file is in the common JSON format of the compliance report ([draft, section 1.6](compliance_implementation_draft.md#16-common-json-format)). The directory is created if needed.

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | `process_check`, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | Always `null`: the script opens no issues |
| `results` | Per active repository one row per check whose family could be read: `repo`, `check`, `name`, `result` (`pass`, `fail` or `na`), `score` (always `null`), `reason` (always filled), `details` |
| `catalogue` | One entry per check: `name` and `documentation` (`url` to the heading below, pinned to `ospo_sha`; `short` rule; `fix`). The by-construction checks have no `fix`, because they cannot fail |
| `skipped` | Repositories without results: `repo` and `reason` (`archived` or `excluded_repos`) |
| `errors` | Per repository and family that could not be read, one row per check of the family: `repo`, `check`, `reason`. See [Errors](#errors). The report treats it as "no data", never as `pass` |

Results are sorted by repository name, then in the order of the table below.

| Check ID | Name | Family |
|---|---|---|
| `advisories/published-in-time` | Advisories Published in Time | [Advisories](#advisories) |
| `by-construction/source-archives` | Source Archives | [By construction](#by-construction) |
| `by-construction/sbom-available` | SBOM Available | [By construction](#by-construction) |
| `releases/versioning` | Versioning | [Releases](#releases) |
| `releases/release-notes` | Release Notes | [Releases](#releases) |

### Errors

Each family is read on its own for each repository, so a failing read does not stop the other families or repositories:

- A 404 on the advisories of a repository (private repository, or a token without advisory permission): one `errors` row for `advisories/published-in-time`, reason "Security advisories not readable (request returned 404: private repository or missing permission)".
- A 404 on the releases of a repository: one `errors` row per release check, reason "Releases not readable (request returned 404: private repository or missing permission)". A 404 on the root contents or the changelog file is no error (see [Release Notes](#release-notes)).
- Any other error in a family (e.g. a 500 or a timeout): one `errors` row per check of the family, reason `Unexpected error: <message>`. The file is still written, and the exit code is `1`.

The by-construction checks read nothing, so they have a `pass` for every active repository, also when the other families failed.

---

## Advisories

### Advisories Published in Time

Every security advisory of the repository published within `advisories.lookback` was published at most `advisories.max_days` days after its creation. The days are whole days from `created_at` to `published_at`, rounded down. A repository without such an advisory passes. Data source: `GET /repos/{owner}/{repo}/security-advisories?state=published`.

- `reason` names the advisories and their days to publication: "1 advisory published in the last 12 months: GHSA-7q4x-2m9c-h3vf after 18 days", or on failure only the late ones: "1 of 2 advisories published later than 90 days: GHSA-p2w8-xr6j-9cq4 after 130 days". Without advisories: "No advisory published in the last 12 months".
- `details` has one line per advisory in the window, sorted by publication: `Info: GHSA-… created 2026-05-02, published 2026-05-20 (18 days)`, or `Warn: …` for a late one.

Limits: advisories that are never published never fail the check. `created_at` is taken as the time of the private report **(verify)**. Vulnerabilities reported through other channels are only measured from the moment an advisory is created.

How to fix: project team with the OSPO: publish advisories within `max_days` days of the report. A late publication counts for `lookback`.

---

## Releases

Both release checks look at the same releases: those published within `releases.lookback`, not drafts, ordered by `published_at`. Data source: `GET /repos/{owner}/{repo}/releases`. A repository without such a release is not a releasing repository: both checks are `na` with the reason "No release in the last 12 months".

### Versioning

Every release has a SemVer or CalVer tag, and within each major version line every release has a higher version than all releases of that line published before it.

- A tag is an optional `v`, two or three numeric parts, an optional pre-release (`-rc.1`) and optional build metadata (`+build.5`): `v1.4.2`, `2026.11`, `2026.11.0-rc.1`. A missing third part counts as `0`. Anything else (`nightly`, `release-5`, `V1.2.3`) fails.
- The major version line is the first number (for CalVer, the year). Versions are compared by SemVer precedence: pre-releases count and come before their release, build metadata is ignored. Releasing an older major line later (a backport, e.g. `v1.9.4` after `v2.0.0`) passes; releasing `v3.0.9` after `v3.1.0` fails, and so does the same version under two tags (`1.0.0` and `v1.0.0`).
- `reason` on pass: "3 releases follow SemVer or CalVer, increasing within each major line". On failure it names the tags that do not parse ("1 of 4 releases not SemVer or CalVer: nightly") and the steps backwards ("version not increasing: v3.0.9 after v3.1.0 in major line 3"), separated by `; `.
- `details`: `Info: releases checked: <tags in publication order>`, then one `Warn:` line per invalid tag or step backwards, with publication dates.

Limits: version lines across major versions are not compared, so a jump back to an older major line passes. Git tags without a release are not checked; git itself guarantees that tag names are unique.

How to fix: project team: tag releases with SemVer or CalVer (e.g. v1.4.2) and keep versions increasing within each major line. A release that breaks the rule counts for `lookback` unless its tag is corrected.

### Release Notes

Every release has release notes: a release body of at least `releases.min_notes_chars` characters (after trimming whitespace), or a `CHANGELOG*` file in the repository root that mentions its version.

- The changelog is read only if at least one release body is too short. The first file in the root whose name starts with `changelog` (case-insensitive, sorted by name) is used. Without such a file, or if the repository has no contents (404), only the release bodies count.
- A version is mentioned if the changelog contains it with or without `v`, and not as part of a longer version: `2.4.1` does not match `2.4.10` or `2.4.1-rc.1`.
- `reason` on pass: "All 3 releases have notes (release body)", or "(release body or CHANGELOG.md)" when the changelog was needed. On failure: "1 of 2 releases without notes: v1.8.0".
- `details` has one line per release: `Info: v2.3.0 release body (812 characters)`, `Info: v2.4.0 mentioned in CHANGELOG.md`, or `Warn: v1.8.0 release body has 0 characters (minimum 50), no CHANGELOG file`.

Limits: only the length of the notes is checked, not whether they describe all functional and security changes. A changelog that mentions the version passes, whatever it says about it.

How to fix: project team: describe the functional and security changes in the GitHub release (or let GitHub generate the notes), or list the version in CHANGELOG.md. Editing an existing release fixes the finding.

---

## By construction

These checks stand for guarantees GitHub gives by design. They test nothing and always pass: one `pass` per check and active repository, with a fixed `reason` per check and empty `details`. Their rule in the catalogue starts with "Not a test; always passes", and the report shows it under "How it is verified".

### Source Archives

Not a test; always passes. GitHub generates the source archives of a release (`.zip`, `.tar.gz`) from the tag, so they contain exactly the repository content at that tag. Built release assets are not covered by this check.

`reason`: "Guaranteed by GitHub: source archives are generated from the tag".

### SBOM Available

Not a test; always passes. The dependency graph is always enabled for public repositories and cannot be switched off, so GitHub can always produce an SBOM for them. That every repository in scope is public is checked separately (`lint/public`). `license_scan` still fetches the SBOM for its deny list; a 404 there is not a finding of this check.

`reason`: "Guaranteed by GitHub: the dependency graph is always enabled for public repositories".
