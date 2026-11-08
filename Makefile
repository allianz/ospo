# Resolve GitHub token from environment or gh CLI
GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)
export GITHUB_TOKEN
export GH_TOKEN = $(GITHUB_TOKEN)

SCRIPTS := scripts
# Tool files (--json) of the integration tests, the dry runs and create_reports; gitignored
JSON_DIR := results

# create_reports: org, tool configs (tool files go to $(JSON_DIR), emptied first),
# reports folder (committed by PR, one subfolder per month, never emptied) and --dry-run for the
# tools that write to GitHub (also in the monthly workflow; DRY_RUN= runs them for real, manual use only)
ORG ?= allianz
CONFIG_DIR ?= config
REPORTS_DIR ?= reports
DRY_RUN ?= --dry-run
# One report per configuration (bsi: BSI TR-03185, allianz: Allianz Mandatory Repository
# Configuration); a new config/compliance_report_*.yaml needs no change here
REPORT_CONFIGS := $(wildcard config/compliance_report_*.yaml)

.PHONY: check-token \
        test_lint_repos test_archive_repos test_create_repos test_license_scan test_by_construction test_advisories_check test_releases_check test_scorecard_check test_community_metrics \
        dry_run_lint_repos dry_run_archive_repos dry_run_create_repos dry_run_license_scan dry_run_by_construction dry_run_advisories_check dry_run_releases_check dry_run_scorecard_check dry_run_community_metrics \
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

test_community_metrics: check-token
	node $(SCRIPTS)/community_metrics.js --org ospo-sandbox --config $(SCRIPTS)/test-config/community_metrics.yaml --debug --json $(JSON_DIR)/community.json

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

dry_run_community_metrics: check-token
	node $(SCRIPTS)/community_metrics.js --org allianz --json $(JSON_DIR)/community.json

# ── Compliance reports ────────────────────────────────────────────────────────

# Runs every tool with --json into a fresh $(JSON_DIR), then aggregates them once per report
# configuration into $(REPORTS_DIR)/<YYYY-MM>/<key>-data.json and <key>-report.html, and builds the
# Scorecard report from scorecard.json (scorecard-data.json, scorecard-report.html) and the community
# report from community.json (community-data.json, community-report.html). A failing
# tool (leading -) leaves no file: the report shows "no data" for its checks. The Scorecard CLI
# must be installed (see test_scorecard_check).
#   make create_reports                                              # allianz, dry-run
#   make create_reports ORG=ospo-sandbox CONFIG_DIR=scripts/test-config
create_reports: check-token
	rm -rf $(JSON_DIR) && mkdir -p $(JSON_DIR)
	-node $(SCRIPTS)/lint_repos.js --org $(ORG) --config $(CONFIG_DIR)/lint_repos.yaml $(DRY_RUN) --json $(JSON_DIR)/lint_repos.json
	-node $(SCRIPTS)/license_scan.js --org $(ORG) --config $(CONFIG_DIR)/license_scan.yaml $(DRY_RUN) --json $(JSON_DIR)/license_scan.json
	-node $(SCRIPTS)/archive_repos.js --org $(ORG) --config $(CONFIG_DIR)/archive_repos.yaml $(DRY_RUN) --json $(JSON_DIR)/archive_repos.json
	-node $(SCRIPTS)/by_construction.js --org $(ORG) --config $(CONFIG_DIR)/by_construction.yaml --json $(JSON_DIR)/by_construction.json
	-node $(SCRIPTS)/advisories_check.js --org $(ORG) --config $(CONFIG_DIR)/advisories_check.yaml --json $(JSON_DIR)/advisories_check.json
	-node $(SCRIPTS)/releases_check.js --org $(ORG) --config $(CONFIG_DIR)/releases_check.yaml --json $(JSON_DIR)/releases_check.json
	-node $(SCRIPTS)/scorecard_check.js --org $(ORG) --config $(CONFIG_DIR)/scorecard_check.yaml --json $(JSON_DIR)/scorecard.json
	-node $(SCRIPTS)/community_metrics.js --org $(ORG) --config $(CONFIG_DIR)/community_metrics.yaml --json $(JSON_DIR)/community.json
	@for c in $(REPORT_CONFIGS); do \
	  echo "node $(SCRIPTS)/compliance_report.js --org $(ORG) --config $$c --dir $(JSON_DIR) --reports $(REPORTS_DIR)"; \
	  node $(SCRIPTS)/compliance_report.js --org $(ORG) --config $$c --dir $(JSON_DIR) --reports $(REPORTS_DIR) || exit 1; \
	done
	node $(SCRIPTS)/scorecard_report.js --org $(ORG) --dir $(JSON_DIR) --reports $(REPORTS_DIR)
	node $(SCRIPTS)/community_report.js --org $(ORG) --dir $(JSON_DIR) --reports $(REPORTS_DIR)

# ── Unit tests ────────────────────────────────────────────────────────────────

test:
	cd $(SCRIPTS) && npm run coverage
