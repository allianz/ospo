# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Allianz OSPO (Open Source Program Office) automation suite for managing GitHub organizations at enterprise scale. Provides tools to create, lint, and archive GitHub repositories while enforcing organizational standards and compliance.

## Commands

### Running Tests (via Makefile in scripts/test/)

```bash
cd scripts/test
make test_create_repos    # Test repo creation against ospo-sandbox org
make test_lint_repos      # Test repo linting against ospo-sandbox org
make test_archive_repos   # Test repo archival against ospo-sandbox org
```

### Running Scripts Directly

```bash
./scripts/create_repos.sh --org <org> [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
./scripts/lint_repos.sh --org <org> [--dry-run] [--debug] [--config <file>]
./scripts/archive_repos.sh --org <org> [--dry-run] [--debug] [--config <file>]
```

All scripts support `--dry-run` for safe validation and `--debug` for verbose output.

### Required Tools

- `yq` (YAML parsing), `jq` (JSON manipulation), `gh` (GitHub CLI), `repolinter` (npm package for linting)

## Architecture

Three independent bash scripts, each driven by a YAML config file:

1. **`scripts/create_repos.sh`** (~485 lines) — Creates/manages repos and teams, assigns permissions, syncs with Azure AD. Reads `config/create_repos.yaml`.
2. **`scripts/lint_repos.sh`** (~231 lines) — Enforces repo compliance (description, topics, license, README, CONTRIBUTING) using `repolinter`. Reads `config/lint_repos.yaml`. Outputs markdown reports to `results/`.
3. **`scripts/archive_repos.sh`** (~192 lines) — Archives stale repos after a grace period with warning issues. Reads `config/archive_repos.yaml`.

### Configuration

- **Production configs**: `config/` directory
- **Test configs**: `scripts/test/` directory (targets `ospo-sandbox` org)

### CI/CD (GitHub Actions)

- `create_repos.yaml` — Dry-run on PR config changes, apply on push to main
- `lint_repos.yml` — Scheduled bi-weekly (Tue/Thu)
- `archive_repos.yml` — Scheduled weekly (Sun midnight)
- All workflows support manual dispatch
- Authentication via GitHub App tokens (`ALLIANZ_APP_ID`, `ALLIANZ_PRIVATE_KEY`)

### Key Patterns

- Scripts use GitHub REST API v2022-11-28 via `gh api`
- Team permission model: custom "Own" role (Enterprise) with "maintain" fallback
- Archive script excludes `.github` and `ospo` repositories
- Linting clones repos to `lint_cache/` for local analysis
- Non-compliant repos get GitHub issues created automatically
