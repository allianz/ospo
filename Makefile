# Resolve GitHub token from environment or gh CLI
GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)
export GITHUB_TOKEN
export GH_TOKEN = $(GITHUB_TOKEN)

SCRIPTS := scripts
# JSON results of the integration tests (--json); gitignored
JSON_DIR := results

# create_reports: org, tool configs, directory of the tool files (gitignored, emptied first),
# reports folder (committed by PR, one subfolder per month, never emptied) and --dry-run for the
# tools that write to GitHub (also in the monthly workflow; DRY_RUN= runs them for real, manual use only)
ORG ?= allianz
CONFIG_DIR ?= config
REPORT_DIR ?= out
REPORTS_DIR ?= reports
DRY_RUN ?= --dry-run
# One report per configuration; a new config/compliance_report_*.yaml needs no change here
REPORT_CONFIGS := $(wildcard config/compliance_report_*.yaml)

.PHONY: check-token \
        test_lint_repos test_archive_repos test_create_repos test_license_scan test_by_construction test_advisories_check test_releases_check test_scorecard_check \
        dry_run_lint_repos dry_run_archive_repos dry_run_create_repos dry_run_license_scan dry_run_by_construction dry_run_advisories_check dry_run_releases_check dry_run_scorecard_check \
        create_reports test coverage

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

test_advisories_check: check-token
	node $(SCRIPTS)/advisories_check.js --org ospo-sandbox --config $(SCRIPTS)/test-config/advisories_check.yaml --debug --json $(JSON_DIR)/advisories_check.json

test_releases_check: check-token
	node $(SCRIPTS)/releases_check.js --org ospo-sandbox --config $(SCRIPTS)/test-config/releases_check.yaml --debug --json $(JSON_DIR)/releases_check.json

# Needs the Scorecard CLI (version pinned in the config) on the PATH or in SCORECARD_BIN
test_scorecard_check: check-token
	node $(SCRIPTS)/scorecard_check.js --org ospo-sandbox --config $(SCRIPTS)/test-config/scorecard_check.yaml --debug --json $(JSON_DIR)/scorecard.json

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

dry_run_advisories_check: check-token
	node $(SCRIPTS)/advisories_check.js --org allianz --json $(JSON_DIR)/advisories_check.json

dry_run_releases_check: check-token
	node $(SCRIPTS)/releases_check.js --org allianz --json $(JSON_DIR)/releases_check.json

dry_run_scorecard_check: check-token
	node $(SCRIPTS)/scorecard_check.js --org allianz --json $(JSON_DIR)/scorecard.json

# ── Compliance reports ────────────────────────────────────────────────────────

# Runs every tool with --json into a fresh $(REPORT_DIR), then aggregates them once per report
# configuration into $(REPORTS_DIR)/<YYYY-MM>/<key>-data.json and <key>-report.html. A failing
# tool (leading -) leaves no file: the report shows "no data" for its checks. The Scorecard CLI
# must be installed (see test_scorecard_check).
#   make create_reports                                              # allianz, dry-run
#   make create_reports ORG=ospo-sandbox CONFIG_DIR=scripts/test-config
create_reports: check-token
	rm -rf $(REPORT_DIR) && mkdir -p $(REPORT_DIR)
	-node $(SCRIPTS)/lint_repos.js --org $(ORG) --config $(CONFIG_DIR)/lint_repos.yaml $(DRY_RUN) --json $(REPORT_DIR)/lint_repos.json
	-node $(SCRIPTS)/license_scan.js --org $(ORG) --config $(CONFIG_DIR)/license_scan.yaml $(DRY_RUN) --json $(REPORT_DIR)/license_scan.json
	-node $(SCRIPTS)/archive_repos.js --org $(ORG) --config $(CONFIG_DIR)/archive_repos.yaml $(DRY_RUN) --json $(REPORT_DIR)/archive_repos.json
	-node $(SCRIPTS)/by_construction.js --org $(ORG) --config $(CONFIG_DIR)/by_construction.yaml --json $(REPORT_DIR)/by_construction.json
	-node $(SCRIPTS)/advisories_check.js --org $(ORG) --config $(CONFIG_DIR)/advisories_check.yaml --json $(REPORT_DIR)/advisories_check.json
	-node $(SCRIPTS)/releases_check.js --org $(ORG) --config $(CONFIG_DIR)/releases_check.yaml --json $(REPORT_DIR)/releases_check.json
	-node $(SCRIPTS)/scorecard_check.js --org $(ORG) --config $(CONFIG_DIR)/scorecard_check.yaml --json $(REPORT_DIR)/scorecard.json
	@for c in $(REPORT_CONFIGS); do \
	  echo "node $(SCRIPTS)/compliance_report.js --org $(ORG) --config $$c --dir $(REPORT_DIR) --reports $(REPORTS_DIR)"; \
	  node $(SCRIPTS)/compliance_report.js --org $(ORG) --config $$c --dir $(REPORT_DIR) --reports $(REPORTS_DIR) || exit 1; \
	done

# ── Unit tests ────────────────────────────────────────────────────────────────

test:
	cd $(SCRIPTS) && npm run coverage
