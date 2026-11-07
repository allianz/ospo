# Spec: by_construction implementation

## Motivation

Some requirements of the compliance report are met by GitHub's own design, not by anything a project team does. For example, GitHub generates the source archives of a release from the tag, and it always enables the dependency graph for public repositories. There is nothing to check. Such a requirement still needs results, so that it has a status, coverage and a card like every other requirement. This script writes these results: one `pass` per check and active repository, in the common JSON format ([draft, section 1.6](compliance_implementation_draft.md#16-common-json-format)).

## Scope

The script:

- lists the repositories of the organisation;
- writes one `pass` result per check for every active repository.

Out of scope:

- Testing anything. The checks are not tests; their rule says so.
- Issues. Project teams cannot fail these checks, so the script never opens or closes an issue and changes nothing on GitHub.

---

## CLI Interface

```
node scripts/by_construction.js --org <org> [--config <file>] [--dry-run] [--debug] [--json <file>]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization whose repositories are listed |
| `--config` | `config/by_construction.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Accepted like in every script. Has no effect: the script makes no changes |
| `--debug` | false | Also print the names of the active, archived and excluded repositories |
| `--json` | – | Write the results to this file as JSON, see [JSON output](#json-output) |

Exit codes: `0` on success, `1` on missing `--org`, missing token, or fatal error.

Requires `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment to list the repositories. The default config path is resolved relative to the repo root, not the working directory.

---

## Configuration File

```yaml
# Repos to skip. Keep this empty: the compliance report counts a skipped
# repository as failing every check of this tool.
excluded_repos: []
```

| Field | Required | Description |
|---|---|---|
| `excluded_repos` | no (default `[]`) | Repository names without results |

An empty file is valid. The config file exists mainly so that the JSON header has `config_file` and `config_sha256` like every other tool.

---

## Output

```
Active repositories: 2 (archived: 1, excluded: 0)
Checks (always pass): by-construction/source-archives, by-construction/sbom-available
```

With `--debug`, the lines `Active repos: …`, `Archived repos: …` and `Excluded repos: …` follow the first line. A list line is left out when the list is empty. With `--json`, the last line is `JSON written to <file>`.

---

## JSON output

With `--json <file>` the script writes its results to `<file>` in the common JSON format of the compliance report. The directory is created if needed. With `--dry-run`, the file is still written.

The file has these keys:

| Key | Content |
|---|---|
| `tool`, `run_at`, `org` | `by_construction`, start of the run (UTC), organisation |
| `ospo_sha` | Commit of the scripts: `GITHUB_SHA`, otherwise `HEAD` of the local checkout, otherwise `null` |
| `config_file`, `config_sha256` | Config path relative to the repo root, and the SHA-256 of the config file |
| `run_url` | Link to the GitHub Actions run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), otherwise `null` |
| `issue_title` | Always `null`: the script opens no issues |
| `results` | One row per active repository and check: `repo`, `check`, `name`, `result` (always `pass`), `score` (always `null`), `reason` (a fixed sentence per check), `details` (always `[]`) |
| `catalogue` | One entry per check ID: `name` and `documentation` (`url` to the heading below, pinned to `ospo_sha`; `short` rule). There is no `fix`, because the checks cannot fail |
| `skipped` | Repositories without results: `repo` and `reason` (`archived` or `excluded_repos`) |
| `errors` | Always `[]`: errors abort the run, and then no file is written |

Results are sorted by repository name, with the checks in the order of the table below.

| Check ID | Name |
|---|---|
| `by-construction/source-archives` | Source Archives |
| `by-construction/sbom-available` | SBOM Available |

### Source Archives

Not a test; always passes. GitHub generates the source archives of a release (`.zip`, `.tar.gz`) from the tag, so they contain exactly the repository content at that tag. Built release assets are not covered by this check.

### SBOM Available

Not a test; always passes. The dependency graph is always enabled for public repositories and cannot be switched off, so GitHub can always produce an SBOM for them. That every repository in scope is public is checked separately (`lint/public`). `license_scan` still fetches the SBOM for its deny list; a 404 there is not a finding of this check.
