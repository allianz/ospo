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
make test_by_construction # Integration test against ospo-sandbox org
make test_advisories_check # Integration test against ospo-sandbox org
make test_releases_check  # Integration test against ospo-sandbox org
make test_scorecard_check # Integration test against ospo-sandbox org (needs the Scorecard CLI)
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
node scripts/by_construction.js --org <org> [--config <file>] [--debug] [--json <file>]
node scripts/advisories_check.js --org <org> --json <file> [--config <file>] [--debug]
node scripts/releases_check.js --org <org> --json <file> [--config <file>] [--debug]
node scripts/scorecard_check.js --org <org> --json <file> [--config <file>] [--debug]
```

All scripts support `--dry-run` for safe validation and `--debug` for verbose output. The three checking scripts also write their results as JSON with `--json <file>` (common format of the compliance report, built with `lib/json_output.js`); see the JSON output section of each spec. `by_construction.js` writes only that JSON: the checks of GitHub guarantees that always pass, one per active repository. `advisories_check.js`, `releases_check.js` and `scorecard_check.js` are JSON only as well (`--json` is required): they open no issues and never write to GitHub.

### Required Tools

- Node.js 26+, npm (runtime for all scripts)
- `gh` (GitHub CLI, used for authentication token resolution in Makefile)
- `scorecard` (OpenSSF Scorecard CLI, for `scorecard_check.js` only), in the version pinned by `scorecard_version` in its config (v5.6.0); on the `PATH` or set `SCORECARD_BIN`

## Specifications

Detailed specs for each script — behaviour, config schema, and output format:

- [`scripts/spec/create_repos_spec.md`](scripts/spec/create_repos_spec.md)
- [`scripts/spec/lint_repos_spec.md`](scripts/spec/lint_repos_spec.md)
- [`scripts/spec/archive_repos_spec.md`](scripts/spec/archive_repos_spec.md)
- [`scripts/spec/license_scan_spec.md`](scripts/spec/license_scan_spec.md)
- [`scripts/spec/by_construction_spec.md`](scripts/spec/by_construction_spec.md)
- [`scripts/spec/advisories_check_spec.md`](scripts/spec/advisories_check_spec.md)
- [`scripts/spec/releases_check_spec.md`](scripts/spec/releases_check_spec.md)
- [`scripts/spec/scorecard_check_spec.md`](scripts/spec/scorecard_check_spec.md)

## Architecture

Eight JavaScript (ESM) scripts, each driven by a YAML config file, built on shared libraries in `scripts/lib/`:

1. **`scripts/create_repos.js`** — Creates/manages repos and teams, assigns permissions, syncs with Azure AD. Reads `config/create_repos.yaml`.
2. **`scripts/lint_repos.js`** — Enforces repo compliance (description, topics, license, README, CONTRIBUTING). Reads `config/lint_repos.yaml`.
3. **`scripts/archive_repos.js`** — Archives stale repos after a grace period with warning issues. Reads `config/archive_repos.yaml`.
4. **`scripts/license_scan.js`** — Scans dependency licenses via the GitHub SBOM API and opens issues for denied licenses. Reads `config/license_scan.yaml`.
5. **`scripts/by_construction.js`** — Writes the `by-construction/*` checks (GitHub guarantees, e.g. source archives, SBOM availability) as JSON: always `pass`, one per active repository, no issues. Reads `config/by_construction.yaml`.
6. **`scripts/advisories_check.js`** — Checks that published security advisories were published within `max_days` of their creation (`advisories/published-in-time`). JSON only: no issues, no writes. Reads `config/advisories_check.yaml`.
7. **`scripts/releases_check.js`** — Checks GitHub releases of the last 12 months: SemVer/CalVer tags increasing within each major line (`releases/versioning`) and release notes in the body or `CHANGELOG*` (`releases/release-notes`); `na` without releases. JSON only: no issues, no writes. Reads `config/releases_check.yaml`.
8. **`scripts/scorecard_check.js`** — Runs the OpenSSF Scorecard CLI per active repository and writes all Scorecard checks (`scorecard/<check>`, score, reason and details unchanged) with thresholds and applicability applied (managed branch protection from `config/create_repos.yaml`, `docs`/`template` topics for CI-Tests, languages for Fuzzing), plus a `repositories` block with the overall score per repository. JSON only: no issues, no writes. Reads `config/scorecard_check.yaml`.

### Shared libraries (`scripts/lib/`)

- `cli.js` — `parseCli` (strict flags), `resolveToken` (`GITHUB_TOKEN` or `GH_TOKEN`), `ScriptError` (printed as `Error: …`), `runIfMain`
- `config.js` — `loadYaml`, `requireFields`, `defaultConfigPath`
- `github.js` — `createOctokit` and `createGitHub`, a wrapper with one named method per GitHub operation. Scripts call GitHub only through this wrapper
- `issues.js` — `findOpenIssue`, `syncIssue` (create/update/close one issue per repo), `syncSummaryIssue` (the OSPO summary issue in `<org>/ospo`)
- `plan.js` — dry-run handling: every change goes through `plan.step(label, fn)` or `plan.apply(fn, { planned, done })`; scripts have no `if (dryRun)` branches for changes
- `logger.js`, `report.js` — output (`info`, `debug`, `step`; headings, skipped lists, dry-run issue summary)
- `json_output.js` — the common JSON tool file of `--json`: header (`buildHeader`), catalogue entries linked to spec headings (`specCatalogue`), result rows (`checkResult`), `writeJsonReport`
- `repos.js`, `dates.js`, `concurrency.js` — `partitionRepos`, `parseRelativeDate`, `mapWithConcurrency`

### Configuration

- **Production configs**: `config/` directory
- **Test configs**: `scripts/test-config/` directory (targets `ospo-sandbox` org)

### CI/CD (GitHub Actions)

- `create_repos.yaml` — Dry-run then apply (two-stage, with environment gate) on push to main when `config/create_repos.yaml` changes
- `lint_repos.yaml` — Scheduled bi-weekly (Tue/Thu)
- `archive_repos.yaml` — Scheduled weekly (Sun midnight)
- `license_scan.yaml` — Scheduled weekly (Mon midnight)
- All workflows support manual dispatch
- Authentication via GitHub App tokens (`ALLIANZ_APP_ID`, `ALLIANZ_PRIVATE_KEY`)

### Key Patterns

- Scripts use GitHub REST API via `@octokit/rest`
- Every script must create its Octokit client with `createOctokit` from `lib/github.js`. It sets `X-GitHub-Api-Version: 2026-03-10` on all requests (without it, Octokit emits deprecation warnings for PATCH/issue endpoints) and silences Octokit's logging. New GitHub calls are added as named methods to `createGitHub` (and to `test/helpers/fake_github.js`)
- Every script exports `run({ argv, env, logger, github, … })` that returns an exit code; all dependencies (GitHub wrapper, logger, `now`, `fetch`, `sleep`, `git`, `scorecard`) are injectable for tests and default to the real ones. The file ends with `runIfMain(import.meta.url, run)`. Never call `process.exit` or `console.*` in script logic
- Keep diff logic (what should change) in pure functions, separate from applying the change, e.g. `diffTeamRepos` in `create_repos.js`
- Team permission model: custom "Own" role (Enterprise) with "maintain" fallback
- Archive script excludes `.github` and `ospo` repositories
- Linting clones repos to `lint_cache/` for local analysis
- License scanning fetches SBOMs via the dependency-graph API (poll-and-redirect), no cloning required
- Non-compliant repos get GitHub issues created automatically
