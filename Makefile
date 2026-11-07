# Resolve GitHub token from environment or gh CLI
GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)
export GITHUB_TOKEN
export GH_TOKEN = $(GITHUB_TOKEN)

SCRIPTS := scripts
# JSON results of the integration tests (--json); gitignored
JSON_DIR := results

.PHONY: check-token \
        test_lint_repos test_archive_repos test_create_repos test_license_scan test_by_construction \
        dry_run_lint_repos dry_run_archive_repos dry_run_create_repos dry_run_license_scan dry_run_by_construction \
        test coverage

check-token:
	@test -n "$(GITHUB_TOKEN)" || (echo "Error: not authenticated. Run 'gh auth login' first." && exit 1)

# ── Integration tests (ospo-sandbox) ─────────────────────────────────────────

test_lint_repos: check-token
	node $(SCRIPTS)/lint_repos.js --org ospo-sandbox --config $(SCRIPTS)/test-config/lint_repos.yaml --debug --json $(JSON_DIR)/lint_repos.json

test_archive_repos: check-token
	node $(SCRIPTS)/archive_repos.js --org ospo-sandbox --config $(SCRIPTS)/test-config/archive_repos.yaml --debug --json $(JSON_DIR)/archive_repos.json

test_create_repos: check-token
	node $(SCRIPTS)/create_repos.js --org ospo-sandbox --config $(SCRIPTS)/test-config/create_repos.yaml --debug

test_license_scan: check-token
	node $(SCRIPTS)/license_scan.js --org ospo-sandbox --config $(SCRIPTS)/test-config/license_scan.yaml --debug --json $(JSON_DIR)/license_scan.json

test_by_construction: check-token
	node $(SCRIPTS)/by_construction.js --org ospo-sandbox --config $(SCRIPTS)/test-config/by_construction.yaml --debug --json $(JSON_DIR)/by_construction.json

# ── Dry runs (allianz) ────────────────────────────────────────────────────────

dry_run_lint_repos: check-token
	node $(SCRIPTS)/lint_repos.js --org allianz --dry-run

dry_run_archive_repos: check-token
	node $(SCRIPTS)/archive_repos.js --org allianz --dry-run

dry_run_create_repos: check-token
	node $(SCRIPTS)/create_repos.js --org allianz --dry-run

dry_run_license_scan: check-token
	node $(SCRIPTS)/license_scan.js --org allianz --dry-run

dry_run_by_construction: check-token
	node $(SCRIPTS)/by_construction.js --org allianz --dry-run

# ── Unit tests ────────────────────────────────────────────────────────────────

test:
	cd $(SCRIPTS) && npm run coverage
