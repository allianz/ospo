# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the Allianz Open Source Program Office (OSPO) automation repository. It manages the Allianz GitHub organization through three bash scripts driven by YAML configuration files.

## Development Setup

Required tools: `gh` (GitHub CLI), `yq`, `jq`, `repolinter`, `licensee` (Ruby gem)

```sh
# Install repolinter
npm install -g repolinter

# Install licensee
gem install licensee
```

## Running Scripts

Each script follows the same pattern: `--org`, `--config`, `--dry-run`, `--debug` flags.

```sh
# Always test with dry-run first
scripts/create_repos.sh --org ospo-sandbox --config config/create_repos.yaml --dry-run --debug
scripts/lint_repos.sh --org ospo-sandbox --config config/lint_create_repos.yaml
scripts/archive_repos.sh --org ospo-sandbox --config config/archive_create_repos.yaml
```

### Running Tests (sandbox org)

```sh
cd scripts
make test_create_repos   # Tests create_repos.sh against ospo-sandbox
make test_lint_repos     # Tests lint_repos.sh against ospo-sandbox
make test_archive_repos  # Tests archive_repos.sh against ospo-sandbox
```

## Architecture

Three scripts, each paired with a config file and a GitHub Actions workflow:

| Script | Config | Workflow |
|--------|--------|----------|
| `scripts/create_repos.sh` | `config/create_repos.yaml` | `.github/workflows/create_create_repos.yaml` |
| `scripts/lint_repos.sh` | `config/lint_create_repos.yaml` | `.github/workflows/lint_repos.yml` |
| `scripts/archive_repos.sh` | `config/archive_create_repos.yaml` | `.github/workflows/archive_repos.yml` |

### `create_repos.sh`
Desired-state management: reads `create_repos.yaml`, compares to actual GitHub org state via `gh` CLI, applies changes. Manages repository creation and team permissions. Supports Azure AD team sync (GitHub Enterprise only — use `--skip-team-sync` and `--skip-custom-role` for non-Enterprise).

### `lint_repos.sh`
Clones each repo, runs `repolinter` with `lint_create_repos.yaml` (or per-repo `.github/repolinter.yaml` override), then creates/closes "Standards Compliance Notice" GitHub issues based on results. Outputs markdown reports to `results/`.

### `archive_repos.sh`
Checks last commit date against `stale_period` in `archive_create_repos.yaml`. Creates "Inactive Repository Reminder" issues, then archives after `grace_period`. Repos listed under `exclude` (e.g., `ospo`, `.github`) are never archived.

## CI/CD

Workflows are manually triggered (`workflow_dispatch`). Scheduled runs are commented out. The `create_repos` and `archive_repos` workflows use GitHub App tokens (App IDs stored as secrets: `ALLIANZ_APP_ID`, `SANDBOX_APP_ID`). The `create_repos` apply step requires manual approval via the `github.com` environment.
