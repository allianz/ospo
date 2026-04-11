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
node scripts/create_repos.js --org <org> [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
node scripts/lint_repos.js --org <org> [--dry-run] [--debug] [--config <file>]
node scripts/archive_repos.js --org <org> [--dry-run] [--debug] [--config <file>]
```

All scripts support `--dry-run` for safe validation and `--debug` for verbose output.

### Required Tools

- Node.js 22+, npm (runtime for all scripts)
- `gh` (GitHub CLI, used for authentication token resolution in Makefile)

## Architecture

Three independent JavaScript (ESM) scripts, each driven by a YAML config file:

1. **`scripts/create_repos.js`** — Creates/manages repos and teams, assigns permissions, syncs with Azure AD. Reads `config/create_repos.yaml`.
2. **`scripts/lint_repos.js`** — Enforces repo compliance (description, topics, license, README, CONTRIBUTING). Reads `config/lint_repos.yaml`.
3. **`scripts/archive_repos.js`** — Archives stale repos after a grace period with warning issues. Reads `config/archive_repos.yaml`.

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

- Scripts use GitHub REST API via `@octokit/rest`
- Team permission model: custom "Own" role (Enterprise) with "maintain" fallback
- Archive script excludes `.github` and `ospo` repositories
- Linting clones repos to `lint_cache/` for local analysis
- Non-compliant repos get GitHub issues created automatically
