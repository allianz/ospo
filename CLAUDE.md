# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Allianz OSPO (Open Source Program Office) automation suite for managing GitHub organizations at enterprise scale. Provides tools to create, lint, archive, and license-scan GitHub repositories while enforcing organizational standards and compliance.

## Commands

### Running Tests (via Makefile in the repo root)

```bash
make test_create_repos    # Integration test against ospo-sandbox org
make test_lint_repos      # Integration test against ospo-sandbox org
make test_archive_repos   # Integration test against ospo-sandbox org
make test_license_scan    # Integration test against ospo-sandbox org
make create_reports       # lint_repos and license_scan --json into results/, then reports/<YYYY-MM>/<key>-data.json + <key>-report.html per config/report/compliance_report_*.yaml
                          # and regenerates reports/README.md (index, links via htmlpreview.github.io)
                          # (allianz, lint_repos and license_scan always with --dry-run, also in CI; ORG=ospo-sandbox CONFIG_DIR=scripts/test-config for the sandbox)
make test                 # Unit tests with coverage report (node --test)
cd scripts && npm test                         # Unit tests without coverage
cd scripts && npm run test:update-snapshots     # Regenerate output snapshots after an intended output change
```

Unit tests must reach at least 90% line coverage for every script. Add or extend tests with every code change so coverage does not drop below that. `npm run coverage` fails below 90% lines overall; also check the per-file table.

Tests live in `scripts/test/` (`test/lib/` for the shared libraries). Each tool has a `run()` scenario test against `test/helpers/fake_github.js` (an in-memory GitHub that records calls and changes its state) plus a snapshot of the full dry-run output (`*.test.js.snapshot`). Script output is captured by the workflows, so treat snapshot changes as output changes.

### Running Scripts Directly

```bash
node scripts/create_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
node scripts/lint_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--json <file>]
node scripts/archive_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--json <file>]
node scripts/license_scan.js --org <org> [--config <file>] [--dry-run] [--debug] [--json <file>]
node scripts/compliance_report.js --org <org> --config <report.yaml> --dir <dir> [--reports <dir>] [--debug]
node scripts/reports_index.js --org <org> [--reports <dir>] [--debug]
```

All scripts support `--dry-run` for safe validation and `--debug` for verbose output. The three checking scripts also write their results as JSON with `--json <file>` (common format of the compliance report, built with `lib/json_output.js`); see the JSON output section of each spec. Only `lint_repos.json` and `license_scan.json` are read by a report today (the Allianz report). `compliance_report.js` reads only the tool files in `--dir` (and the latest earlier `<reports>/<YYYY-MM>/<key>-data.json` for the history; no git) and writes `<reports>/<YYYY-MM>/<key>-data.json` plus the self-contained HTML report `<key>-report.html` (default `reports/`, committed by PR; the tool files in `results/` are not). The only report configuration is `config/report/compliance_report_allianz.yaml`. `reports_index.js` writes `<reports>/README.md`, the index of all month folders: the reports of the latest month and one line per earlier month, each HTML report linked through `htmlpreview.github.io` on `main` (GitHub shows `.html` as source). A Markdown report is not implemented yet.

### Required Tools

- Node.js 26+, npm (runtime for all scripts)
- `gh` (GitHub CLI, used for authentication token resolution in Makefile)

## Specifications

Detailed specs for each script — behaviour, config schema, and output format:

- [`scripts/spec/create_repos_spec.md`](scripts/spec/create_repos_spec.md)
- [`scripts/spec/lint_repos_spec.md`](scripts/spec/lint_repos_spec.md)
- [`scripts/spec/archive_repos_spec.md`](scripts/spec/archive_repos_spec.md)
- [`scripts/spec/license_scan_spec.md`](scripts/spec/license_scan_spec.md)
- [`scripts/spec/compliance_report_spec.md`](scripts/spec/compliance_report_spec.md)
- [`scripts/spec/reports_index_spec.md`](scripts/spec/reports_index_spec.md)

## Architecture

Six JavaScript (ESM) scripts, each driven by a YAML config file (except `reports_index.js`), built on shared libraries in `scripts/lib/`:

1. **`scripts/create_repos.js`** — Creates/manages repos and teams, assigns permissions, syncs with Azure AD. Reads `config/create_repos.yaml`.
2. **`scripts/lint_repos.js`** — Enforces repo compliance (description, topics, license, README, CONTRIBUTING). Reads `config/lint_repos.yaml`.
3. **`scripts/archive_repos.js`** — Archives stale repos after a grace period with warning issues. Reads `config/archive_repos.yaml`.
4. **`scripts/license_scan.js`** — Scans dependency licenses via the GitHub SBOM API and opens issues for denied licenses. Reads `config/license_scan.yaml`.
5. **`scripts/compliance_report.js`** — Aggregates the tool files of one run into `<key>-data.json` per report configuration (`config/report/compliance_report_<key>.yaml`, which holds the requirement texts and the only check → requirement mapping; today only `allianz`, the Allianz Repository Standards, fed by `lint_repos.json` and `license_scan.json`): validates and merges them, adds `fail` for repositories a tool excluded, computes statuses, coverage and summary, carries `history` forward from the latest earlier month folder in the local `reports/`, reads the notes file, and renders `<key>-report.html` (template `scripts/templates/compliance_report.html`, which renders itself in the browser from the embedded `data.json`). No GitHub calls.
6. **`scripts/reports_index.js`** — Regenerates `reports/README.md`, the index of the reports folder: the reports of the latest month (name from the HTML `<title>`, link via `htmlpreview.github.io` to the file on `main`) and one line per earlier month. Run last by `make create_reports`, so the index is part of the report PR. No config, no GitHub calls.

### Shared libraries (`scripts/lib/`)

- `cli.js` — `parseCli` (strict flags), `resolveToken` (`GITHUB_TOKEN` or `GH_TOKEN`), `ScriptError` (printed as `Error: …`), `runIfMain`
- `config.js` — `loadYaml`, `requireFields`, `defaultConfigPath`
- `github.js` — `createOctokit` and `createGitHub`, a wrapper with one named method per GitHub operation. Scripts call GitHub only through this wrapper
- `issues.js` — `findOpenIssue`, `syncIssue` (create/update/close one issue per repo), `syncSummaryIssue` (the OSPO summary issue in `<org>/ospo`)
- `plan.js` — dry-run handling: every change goes through `plan.step(label, fn)` or `plan.apply(fn, { planned, done })`; scripts have no `if (dryRun)` branches for changes
- `logger.js`, `report.js` — output (`info`, `debug`, `step`; headings, skipped lists, dry-run issue summary)
- `json_output.js` — the common JSON tool file of `--json`: header (`buildHeader`), catalogue entries linked to spec headings (`specCatalogue`), result rows (`checkResult`), `writeJsonReport`; helpers `sha256`, `blobUrl`, `repoRelative`, `isoSeconds`
- `report_html.js` — `renderHtml(data, template, title?)`: embeds `data.json` (escaped) and the title into a template (`scripts/templates/compliance_report.html`)
- `report_files.js` — used by `compliance_report.js`: `readToolFile`/`validateToolFile` (tool file status `ok`/`missing`/`invalid`), `readPreviousReport`, `mergeHistory`, `DEFAULT_REPORTS_PATH`
- `repos.js`, `dates.js`, `concurrency.js` — `partitionRepos`, `parseRelativeDate`, `mapWithConcurrency`

### Configuration

- **Production configs**: `config/` directory: the tools that act on GitHub (`create_repos`, `lint_repos`, `archive_repos`, `license_scan`) directly in `config/`; the report configurations (`compliance_report_<key>.yaml` and its `_notes.md`) in `config/report/` (`defaultConfigPath(name, 'report')`)
- **Test configs**: `scripts/test-config/` directory (targets `ospo-sandbox` org), so `CONFIG_DIR=scripts/test-config` works for `make create_reports`

### Output folders

- `results/` (Makefile `JSON_DIR`, gitignored) is the only folder for tool files (`--json`), used by every Make target and the workflows. `reports/` holds the committed reports (`<YYYY-MM>/<key>-data.json`, `<key>-report.html`) and the generated index `reports/README.md`. Before adding a new output folder or Makefile variable for a path, check whether an existing one already serves the purpose, and reuse it.

### CI/CD (GitHub Actions)

- `create_repos.yaml` — Dry-run then apply (two-stage, with environment gate) on push to main when `config/create_repos.yaml` changes
- `lint_repos.yaml` — Scheduled bi-weekly (Tue/Thu)
- `archive_repos.yaml` — Scheduled weekly (Sun midnight)
- `license_scan.yaml` — Scheduled weekly (Mon midnight)
- `compliance_report.yaml` — Monthly (1st, 03:00 UTC) and on edits of `config/report/compliance_report_*_notes.md` in the report PR: `make create_reports` (`lint_repos` and `license_scan` with `--dry-run`, so it never writes issues), commits `reports/<YYYY-MM>/` and `reports/README.md` to the branch `compliance-report` (merging `main` into it) and opens the PR (its body links the reports on the branch via htmlpreview); tool files and reports are uploaded as artifact
- `ci.yaml` — On pull requests that change `scripts/`, the `Makefile` or the workflow itself: `make test` (unit tests with the coverage thresholds)
- All workflows support manual dispatch
- Authentication via GitHub App tokens (`ALLIANZ_APP_ID`, `ALLIANZ_PRIVATE_KEY`)

### Key Patterns

- Scripts use GitHub REST API via `@octokit/rest`
- Every script must create its Octokit client with `createOctokit` from `lib/github.js`. It sets `X-GitHub-Api-Version: 2026-03-10` on all requests (without it, Octokit emits deprecation warnings for PATCH/issue endpoints) and silences Octokit's logging. New GitHub calls are added as named methods to `createGitHub` (and to `test/helpers/fake_github.js`)
- Every script exports `run({ argv, env, logger, github, … })` that returns an exit code; all dependencies (GitHub wrapper, logger, `now`, `fetch`, `sleep`, `git`) are injectable for tests and default to the real ones. The file ends with `runIfMain(import.meta.url, run)`. Never call `process.exit` or `console.*` in script logic
- Keep diff logic (what should change) in pure functions, separate from applying the change, e.g. `diffTeamRepos` in `create_repos.js`
- Team permission model: custom "Own" role (Enterprise) with "maintain" fallback
- Archive script excludes `.github` and `ospo` repositories
- Linting clones repos to `lint_cache/` for local analysis
- License scanning fetches SBOMs via the dependency-graph API (poll-and-redirect), no cloning required
- Non-compliant repos get GitHub issues created automatically
