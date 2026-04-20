# Contribution Guidelines

Thank you for your interest in contributing to this project!

Reach out on our collaboration channels if you need assistance.

## Ways to Contribute

- **Code**: Help improve our automation scripts.
- **Documentation**: Enhance our guides with feedback and improvements.

## Setting Up Your Development Environment

Required tools:

- [Node.js](https://nodejs.org/) 22+, npm
- [gh](https://cli.github.com/) (GitHub CLI — used for authentication token resolution in the Makefile)
- `git` (required at runtime by `lint_repos.js` for cloning repositories)

Install script dependencies:

```bash
cd scripts
npm install
```

## Project Structure

| Script | Config | Workflow | Description |
|---|---|---|---|
| `scripts/create_repos.js` | `config/create_repos.yaml` | `.github/workflows/create_repos.yaml` | Create repositories, manage teams, sync with Entra ID |
| `scripts/lint_repos.js` | `config/lint_repos.yaml` | `.github/workflows/lint_repos.yml` | Enforce minimum repository standards |
| `scripts/archive_repos.js` | `config/archive_repos.yaml` | `.github/workflows/archive_repos.yml` | Archive stale projects |

For full details on each script's behaviour, configuration, and output format, see the [specs](scripts/spec/).

## Running Scripts

All scripts require a `GITHUB_TOKEN` environment variable:

```bash
export GITHUB_TOKEN=$(gh auth token)
```

Then run from the repo root:

```bash
node scripts/create_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
node scripts/lint_repos.js   --org <org> [--config <file>] [--dry-run] [--debug]
node scripts/archive_repos.js --org <org> [--config <file>] [--dry-run] [--debug]
```

All scripts support `--dry-run` (validate without making changes) and `--debug` (verbose output).

## Testing

Use the sandbox environment to test scripts against the `ospo-sandbox` organization:

```bash
cd scripts
make test_create_repos    # Test repo creation
make test_lint_repos      # Test repo linting
make test_archive_repos   # Test repo archival
make test                 # Run unit tests
```

To run against your own test organization without Enterprise features:

```bash
node scripts/create_repos.js --org my-test-org --config scripts/test-config/create_repos.yaml \
  --skip-team-sync --skip-custom-role --debug --dry-run
```
