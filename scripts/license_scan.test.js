import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  checkDependencyLicenses,
  buildIssueBody,
  findOpenIssue,
  fetchSbomPackages,
} from './license_scan.js';

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir;
  before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'license-scan-test-')); });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('parses a valid config', async () => {
    const file = path.join(tmpDir, 'valid.yaml');
    await writeFile(file, [
      'issue_title: "Dependency License Violation"',
      'docs_link: "https://example.com/policy"',
      'excluded_repos: [some-repo]',
      'deny-licenses:',
      '  - GPL-3.0',
      '  - AGPL-3.0',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.issue_title, 'Dependency License Violation');
    assert.equal(cfg.docs_link, 'https://example.com/policy');
    assert.deepEqual(cfg.excluded_repos, ['some-repo']);
    assert.deepEqual(cfg['deny-licenses'], ['GPL-3.0', 'AGPL-3.0']);
  });

  it('throws when issue_title is missing', async () => {
    const file = path.join(tmpDir, 'no-title.yaml');
    await writeFile(file, 'deny-licenses:\n  - GPL-3.0\n');
    await assert.rejects(() => loadConfig(file), /issue_title/);
  });

  it('throws when deny-licenses is missing', async () => {
    const file = path.join(tmpDir, 'no-deny.yaml');
    await writeFile(file, 'issue_title: "T"\n');
    await assert.rejects(() => loadConfig(file), /deny-licenses/);
  });

  it('throws when deny-licenses is empty', async () => {
    const file = path.join(tmpDir, 'empty-deny.yaml');
    await writeFile(file, 'issue_title: "T"\ndeny-licenses: []\n');
    await assert.rejects(() => loadConfig(file), /deny-licenses/);
  });

  it('defaults excluded_repos to [] when absent', async () => {
    const file = path.join(tmpDir, 'no-excluded.yaml');
    await writeFile(file, 'issue_title: "T"\ndeny-licenses:\n  - GPL-3.0\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.excluded_repos, []);
  });

  it('defaults docs_link to empty string when absent', async () => {
    const file = path.join(tmpDir, 'no-docs-link.yaml');
    await writeFile(file, 'issue_title: "T"\ndeny-licenses:\n  - GPL-3.0\n');
    const cfg = await loadConfig(file);
    assert.equal(cfg.docs_link, '');
  });
});

// ── checkDependencyLicenses ───────────────────────────────────────────────────

describe('checkDependencyLicenses', () => {
  const denyList = ['GPL-3.0', 'GPL-3.0-only', 'AGPL-3.0'];

  const pkg = (name, version, license) => ({ name, versionInfo: version, licenseConcluded: license });

  it('returns empty array when all packages are clean', () => {
    const packages = [
      pkg('lodash', '4.17.21', 'MIT'),
      pkg('express', '4.18.0', 'MIT'),
    ];
    assert.deepEqual(checkDependencyLicenses(packages, denyList), []);
  });

  it('returns one violation for a single denied license', () => {
    const packages = [pkg('bad-lib', '1.0.0', 'GPL-3.0')];
    const violations = checkDependencyLicenses(packages, denyList);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, 'bad-lib');
    assert.equal(violations[0].version, '1.0.0');
    assert.equal(violations[0].spdxId, 'GPL-3.0');
  });

  it('returns all violations when multiple packages are denied', () => {
    const packages = [
      pkg('lib-a', '1.0.0', 'GPL-3.0'),
      pkg('lib-b', '2.0.0', 'AGPL-3.0'),
    ];
    const violations = checkDependencyLicenses(packages, denyList);
    assert.equal(violations.length, 2);
  });

  it('returns only denied packages in a mixed list', () => {
    const packages = [
      pkg('clean-lib', '1.0.0', 'MIT'),
      pkg('bad-lib', '1.0.0', 'GPL-3.0-only'),
      pkg('another-clean', '1.0.0', 'Apache-2.0'),
    ];
    const violations = checkDependencyLicenses(packages, denyList);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, 'bad-lib');
  });

  it('silently skips packages with NOASSERTION spdxId', () => {
    const packages = [pkg('unknown-lib', '1.0.0', 'NOASSERTION')];
    assert.deepEqual(checkDependencyLicenses(packages, denyList), []);
  });

  it('silently skips packages with NONE spdxId', () => {
    const packages = [pkg('no-license-lib', '1.0.0', 'NONE')];
    assert.deepEqual(checkDependencyLicenses(packages, denyList), []);
  });

  it('silently skips packages with null spdxId', () => {
    const packages = [pkg('null-lib', '1.0.0', null)];
    assert.deepEqual(checkDependencyLicenses(packages, denyList), []);
  });

  it('passes on empty packages list', () => {
    assert.deepEqual(checkDependencyLicenses([], denyList), []);
  });

  it('falls back to licenseDeclared when licenseConcluded is absent', () => {
    const packages = [
      { name: 'declared-bad', versionInfo: '1.0.0', licenseDeclared: 'GPL-3.0' },
      { name: 'declared-clean', versionInfo: '1.0.0', licenseDeclared: 'MIT' },
    ];
    const violations = checkDependencyLicenses(packages, denyList);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, 'declared-bad');
    assert.equal(violations[0].spdxId, 'GPL-3.0');
  });

  it('prefers licenseConcluded over licenseDeclared when both are present', () => {
    const packages = [
      { name: 'mixed', versionInfo: '1.0.0', licenseConcluded: 'MIT', licenseDeclared: 'GPL-3.0' },
    ];
    assert.deepEqual(checkDependencyLicenses(packages, denyList), []);
  });
});

// ── buildIssueBody ────────────────────────────────────────────────────────────

describe('buildIssueBody', () => {
  const violations = [
    { name: 'my-lib', version: '1.2.3', spdxId: 'GPL-3.0' },
    { name: 'other-lib', version: '0.5.0', spdxId: 'AGPL-3.0' },
  ];

  it('generates correct table rows for each violation', () => {
    const body = buildIssueBody(violations, { docs_link: '' });
    assert.ok(body.includes('| my-lib | 1.2.3 | GPL-3.0 |'));
    assert.ok(body.includes('| other-lib | 0.5.0 | AGPL-3.0 |'));
  });

  it('inserts docs_link when provided', () => {
    const body = buildIssueBody(violations, { docs_link: 'https://example.com/policy' });
    assert.ok(body.includes('[License Policy](https://example.com/policy)'));
  });

  it('omits link when docs_link is empty', () => {
    const body = buildIssueBody(violations, { docs_link: '' });
    assert.ok(!body.includes('[License Policy]'));
    assert.ok(body.includes('Please replace or remove the dependencies above.'));
  });

  it('includes attribution line', () => {
    const body = buildIssueBody(violations, { docs_link: '' });
    assert.ok(body.includes('_This issue was automatically generated by the OSPO license scanner._'));
  });
});

// ── findOpenIssue ─────────────────────────────────────────────────────────────

describe('findOpenIssue', () => {
  it('returns issue number when a matching open issue is found', async () => {
    const octokit = {
      paginate: async (_fn, _opts) => [
        { number: 42, title: 'Dependency License Violation', pull_request: undefined },
        { number: 7, title: 'Something Else', pull_request: undefined },
      ],
      rest: { issues: { listForRepo: {} } },
    };
    const result = await findOpenIssue(octokit, 'org', 'repo', 'Dependency License Violation');
    assert.equal(result, 42);
  });

  it('returns null when no matching issue exists', async () => {
    const octokit = {
      paginate: async (_fn, _opts) => [
        { number: 7, title: 'Something Else', pull_request: undefined },
      ],
      rest: { issues: { listForRepo: {} } },
    };
    const result = await findOpenIssue(octokit, 'org', 'repo', 'Dependency License Violation');
    assert.equal(result, null);
  });

  it('ignores pull requests with a matching title', async () => {
    const octokit = {
      paginate: async (_fn, _opts) => [
        { number: 99, title: 'Dependency License Violation', pull_request: { url: 'https://...' } },
      ],
      rest: { issues: { listForRepo: {} } },
    };
    const result = await findOpenIssue(octokit, 'org', 'repo', 'Dependency License Violation');
    assert.equal(result, null);
  });

  it('returns null for an empty issue list', async () => {
    const octokit = {
      paginate: async (_fn, _opts) => [],
      rest: { issues: { listForRepo: {} } },
    };
    const result = await findOpenIssue(octokit, 'org', 'repo', 'Dependency License Violation');
    assert.equal(result, null);
  });
});

// ── fetchSbomPackages ─────────────────────────────────────────────────────────

describe('fetchSbomPackages', () => {
  const REPORT_URL = 'https://api.github.com/sbom-report/abc';
  const DOWNLOAD_URL = 'https://api.github.com/sbom-download/abc';

  // Stub setTimeout so polling waits resolve immediately. Restored after each test.
  const realSetTimeout = globalThis.setTimeout;
  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.setTimeout = fn => { fn(); return 0; };
  });
  after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.fetch = realFetch;
  });

  // Build an octokit stub whose .request returns the given sbom_url (or omits it).
  const octokitWithReport = (sbomUrl) => ({
    request: async () => ({ data: sbomUrl === undefined ? {} : { sbom_url: sbomUrl } }),
  });

  // Build a fetch stub that returns scripted responses, one per call. The last
  // response is reused for any extra calls (so download responses don't need a
  // separate counter when paired with a single 302).
  const scriptedFetch = (responses) => {
    let i = 0;
    return async (url) => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return typeof r === 'function' ? r(url) : r;
    };
  };

  // Helpers for building Response-like objects.
  const pollResponse = (status, location) => ({
    status,
    headers: { get: (h) => h.toLowerCase() === 'location' ? location : null },
  });
  const downloadResponse = (ok, payload, status = 200) => ({
    ok,
    status,
    json: async () => payload,
  });

  it('returns packages from top-level sbom.packages on 302', async () => {
    const pkgs = [{ name: 'lodash', licenseConcluded: 'MIT' }];
    globalThis.fetch = scriptedFetch([
      pollResponse(302, DOWNLOAD_URL),
      downloadResponse(true, { packages: pkgs }),
    ]);
    const result = await fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok');
    assert.deepEqual(result.packages, pkgs);
    assert.equal(result.pollAttempts, 1);
  });

  it('returns packages from nested sbom.sbom.packages on 302', async () => {
    const pkgs = [{ name: 'express', licenseConcluded: 'MIT' }];
    globalThis.fetch = scriptedFetch([
      pollResponse(302, DOWNLOAD_URL),
      downloadResponse(true, { sbom: { packages: pkgs } }),
    ]);
    const result = await fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok');
    assert.deepEqual(result.packages, pkgs);
  });

  it('returns empty packages list when SBOM has no packages field', async () => {
    globalThis.fetch = scriptedFetch([
      pollResponse(302, DOWNLOAD_URL),
      downloadResponse(true, {}),
    ]);
    const result = await fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok');
    assert.deepEqual(result.packages, []);
  });

  it('throws when sbom_url is missing from initial response', async () => {
    await assert.rejects(
      () => fetchSbomPackages(octokitWithReport(undefined), 'org', 'repo', 'tok'),
      /SBOM report URL missing for org\/repo/,
    );
  });

  it('throws when download response is not ok', async () => {
    globalThis.fetch = scriptedFetch([
      pollResponse(302, DOWNLOAD_URL),
      downloadResponse(false, null, 404),
    ]);
    await assert.rejects(
      () => fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok'),
      /SBOM download failed for org\/repo: status 404/,
    );
  });

  it('polls again on 202 and succeeds on subsequent 302', async () => {
    const pkgs = [{ name: 'foo', licenseConcluded: 'MIT' }];
    globalThis.fetch = scriptedFetch([
      pollResponse(202),
      pollResponse(202),
      pollResponse(302, DOWNLOAD_URL),
      downloadResponse(true, { packages: pkgs }),
    ]);
    const result = await fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok');
    assert.deepEqual(result.packages, pkgs);
    assert.equal(result.pollAttempts, 3);
  });

  it('retries on 5xx and succeeds on subsequent 302', async () => {
    const pkgs = [{ name: 'bar', licenseConcluded: 'MIT' }];
    globalThis.fetch = scriptedFetch([
      pollResponse(503),
      pollResponse(502),
      pollResponse(302, DOWNLOAD_URL),
      downloadResponse(true, { packages: pkgs }),
    ]);
    const result = await fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok');
    assert.deepEqual(result.packages, pkgs);
    assert.equal(result.pollAttempts, 3);
  });

  it('throws after 3 consecutive 5xx responses', async () => {
    globalThis.fetch = scriptedFetch([
      pollResponse(500),
      pollResponse(502),
      pollResponse(503),
    ]);
    await assert.rejects(
      () => fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok'),
      /3 consecutive 5xx responses/,
    );
  });

  it('throws immediately on unexpected status (e.g. 404)', async () => {
    globalThis.fetch = scriptedFetch([pollResponse(404)]);
    await assert.rejects(
      () => fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok'),
      /SBOM polling failed for org\/repo: status 404/,
    );
  });

  it('throws after exhausting max poll attempts on continuous 202', async () => {
    globalThis.fetch = scriptedFetch([pollResponse(202)]);
    await assert.rejects(
      () => fetchSbomPackages(octokitWithReport(REPORT_URL), 'org', 'repo', 'tok'),
      /not ready after \d+s\. Giving up\./,
    );
  });
});
