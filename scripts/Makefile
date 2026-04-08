# Resolve GitHub token from environment or gh CLI
GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)
export GITHUB_TOKEN
export GH_TOKEN = $(GITHUB_TOKEN)

.PHONY: check-token \
        test_lint_repos test_archive_repos test_create_repos \
        dry_run_lint_repos dry_run_archive_repos dry_run_create_repos \
        test

check-token:
	@test -n "$(GITHUB_TOKEN)" || (echo "Error: not authenticated. Run 'gh auth login' first." && exit 1)

# ── Integration tests (ospo-sandbox) ─────────────────────────────────────────

test_lint_repos: check-token
	node lint_repos.js --org ospo-sandbox --config test-config/lint_repos.yaml --debug

test_archive_repos: check-token
	./archive_repos.sh --org ospo-sandbox --config test-config/archive_repos.yaml --debug

test_create_repos: check-token
	node create_repos.js --org ospo-sandbox --config test-config/create_repos.yaml --skip-team-sync --skip-custom-role 

# ── Dry runs (allianz) ────────────────────────────────────────────────────────

dry_run_lint_repos: check-token
	node lint_repos.js --org allianz --dry-run

dry_run_archive_repos: check-token
	./archive_repos.sh --org allianz --dry-run

dry_run_create_repos: check-token
	node create_repos.js --org allianz --dry-run

# ── Unit tests ────────────────────────────────────────────────────────────────

test:
	npm test
