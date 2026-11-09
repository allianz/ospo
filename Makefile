# Resolve GitHub token from environment or gh CLI
GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)
export GITHUB_TOKEN
export GH_TOKEN = $(GITHUB_TOKEN)

SCRIPTS := scripts
# Tool files (--json) of the integration tests, the dry runs and create_reports; gitignored
JSON_DIR := results

# create_reports: org, tool configs (tool files go to $(JSON_DIR), emptied first) and
# reports folder (committed by PR, one subfolder per month, never emptied)
ORG ?= allianz
CONFIG_DIR ?= config
REPORTS_DIR ?= reports
# One report per configuration (bsi: BSI TR-03185, allianz: Allianz Mandatory Repository
# Configuration); a new config/report/compliance_report_*.yaml needs no change here
REPORT_CONFIGS := $(wildcard config/report/compliance_report_*.yaml)

.PHONY: check-token \
        test_lint_repos test_archive_repos test_create_repos test_license_scan \
        dry_run_lint_repos dry_run_archive_repos dry_run_create_repos dry_run_license_scan \
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

# ── Dry runs (allianz) ────────────────────────────────────────────────────────

dry_run_lint_repos: check-token
	node $(SCRIPTS)/lint_repos.js --org allianz --dry-run

dry_run_archive_repos: check-token
	node $(SCRIPTS)/archive_repos.js --org allianz --dry-run

dry_run_create_repos: check-token
	node $(SCRIPTS)/create_repos.js --org allianz --dry-run

dry_run_license_scan: check-token
	node $(SCRIPTS)/license_scan.js --org allianz --dry-run

# ── Compliance reports ────────────────────────────────────────────────────────

# Runs every tool with --json into a fresh $(JSON_DIR), then aggregates them once per report
# configuration into $(REPORTS_DIR)/<YYYY-MM>/<key>-data.json and <key>-report.html, and builds the
# Scorecard report from scorecard.json (scorecard-data.json, scorecard-report.html) and the community
# report from community.json (community-data.json, community-report.html), and regenerates the
# index $(REPORTS_DIR)/README.md (latest month, links via htmlpreview.github.io). A failing
# tool (leading -) leaves no file: the report shows "no data" for its checks. process_check still
# writes its file when single API reads fail; they are listed in its errors. The Scorecard CLI
# must be installed (version pinned in the scorecard_check config), on the PATH or in SCORECARD_BIN.
# The tools that write to GitHub (lint_repos, license_scan, archive_repos) always run with --dry-run:
# a report run never opens or closes issues and never archives.
#   make create_reports                                              # allianz
#   make create_reports ORG=ospo-sandbox CONFIG_DIR=scripts/test-config
create_reports: check-token
	rm -rf $(JSON_DIR) && mkdir -p $(JSON_DIR)
	-node $(SCRIPTS)/lint_repos.js --org $(ORG) --config $(CONFIG_DIR)/lint_repos.yaml --dry-run --json $(JSON_DIR)/lint_repos.json
	-node $(SCRIPTS)/license_scan.js --org $(ORG) --config $(CONFIG_DIR)/license_scan.yaml --dry-run --json $(JSON_DIR)/license_scan.json
	-node $(SCRIPTS)/archive_repos.js --org $(ORG) --config $(CONFIG_DIR)/archive_repos.yaml --dry-run --json $(JSON_DIR)/archive_repos.json
	-node $(SCRIPTS)/process_check.js --org $(ORG) --config $(CONFIG_DIR)/report/process_check.yaml --json $(JSON_DIR)/process_check.json
	-node $(SCRIPTS)/scorecard_check.js --org $(ORG) --config $(CONFIG_DIR)/report/scorecard_check.yaml --json $(JSON_DIR)/scorecard.json
	-node $(SCRIPTS)/community_metrics.js --org $(ORG) --config $(CONFIG_DIR)/report/community_metrics.yaml --json $(JSON_DIR)/community.json
	@for c in $(REPORT_CONFIGS); do \
	  echo "node $(SCRIPTS)/compliance_report.js --org $(ORG) --config $$c --dir $(JSON_DIR) --reports $(REPORTS_DIR)"; \
	  node $(SCRIPTS)/compliance_report.js --org $(ORG) --config $$c --dir $(JSON_DIR) --reports $(REPORTS_DIR) || exit 1; \
	done
	node $(SCRIPTS)/scorecard_report.js --org $(ORG) --dir $(JSON_DIR) --reports $(REPORTS_DIR)
	node $(SCRIPTS)/community_report.js --org $(ORG) --dir $(JSON_DIR) --reports $(REPORTS_DIR)
	node $(SCRIPTS)/reports_index.js --org $(ORG) --reports $(REPORTS_DIR)

# ── Unit tests ────────────────────────────────────────────────────────────────

test:
	cd $(SCRIPTS) && npm run coverage
