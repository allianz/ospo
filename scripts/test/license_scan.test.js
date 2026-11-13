import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OSPO_LICENSE_ISSUE_TITLE,
  buildCatalogue,
  buildJsonResults,
  buildIssueBody,
  buildOspoLicenseIssueBody,
  checkDependencyLicenses,
  fetchSbomPackages,
  formatRepoResult,
  licenseOf,
  loadConfig,
  run,
  summarizeLicenses,
} from '../license_scan.js';
import { createFakeGitHub, notFound } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'license-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

async function writeConfig(name, lines) {
  const file = path.join(tmpDir, name);
  await writeFile(file, lines.join('\n'));
  return file;
}

const pkg = (name, license, version = '1.0.0') => ({ name, versionInfo: version, licenseConcluded: license });

// ── Fake SBOM endpoint ────────────────────────────────────────────────────────

/** A fetch() that answers the poll URL with the given status sequence, then serves `sbom` as the download. */
function sbomFetch(statuses, sbom = { sbom: { packages: [] } }, { downloadStatus = 200 } = {}) {
  const calls = [];
  const queue = [...statuses];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://download.example/sbom.json') {
      return { ok: downloadStatus === 200, status: downloadStatus, json: async () => sbom };
    }
    const status = queue.length > 1 ? queue.shift() : queue[0];
    return { status, headers: new Map([['location', 'https://download.example/sbom.json']]) };
  };
  fetch.calls = calls;
  return fetch;
}

const noSleep = async () => {};

// ── Config ────────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('parses a valid config and applies defaults', async () => {
    const file = await writeConfig('valid.yaml', ['issue_title: License Violation', 'deny-licenses: [GPL-3.0-only, AGPL-3.0-only]']);
    const cfg = await loadConfig(file);
    assert.equal(cfg.issue_title, 'License Violation');
    assert.deepEqual(cfg['deny-licenses'], ['GPL-3.0-only', 'AGPL-3.0-only']);
    assert.deepEqual(cfg.excluded_repos, []);
    assert.equal(cfg.docs_link, '');
  });

  it('keeps excluded_repos and docs_link', async () => {
    const file = await writeConfig('full.yaml', ['issue_title: T', 'deny-licenses: [GPL-3.0-only]', 'excluded_repos: [ospo]', 'docs_link: https://x']);
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.excluded_repos, ['ospo']);
    assert.equal(cfg.docs_link, 'https://x');
  });

  for (const [name, lines, error] of [
    ['missing issue_title', ['deny-licenses: [GPL-3.0-only]'], /issue_title/],
    ['missing deny-licenses', ['issue_title: T'], /deny-licenses/],
    ['empty deny-licenses', ['issue_title: T', 'deny-licenses: []'], /deny-licenses/],
  ]) {
    it(`throws on ${name}`, async () => {
      const file = await writeConfig(`${name.replace(/ /g, '-')}.yaml`, lines);
      await assert.rejects(() => loadConfig(file), error);
    });
  }
});

// ── Checks ────────────────────────────────────────────────────────────────────

describe('licenseOf', () => {
  it('prefers licenseConcluded and falls back to licenseDeclared', () => {
    assert.equal(licenseOf({ licenseConcluded: 'MIT', licenseDeclared: 'GPL-3.0-only' }), 'MIT');
    assert.equal(licenseOf({ licenseDeclared: 'GPL-3.0-only' }), 'GPL-3.0-only');
  });

  it('returns null for NOASSERTION, NONE and missing values', () => {
    assert.equal(licenseOf({ licenseConcluded: 'NOASSERTION' }), null);
    assert.equal(licenseOf({ licenseConcluded: 'NONE' }), null);
    assert.equal(licenseOf({}), null);
  });
});

describe('checkDependencyLicenses', () => {
  const deny = ['GPL-3.0-only', 'AGPL-3.0-only'];

  it('returns no violations for clean or empty package lists', () => {
    assert.deepEqual(checkDependencyLicenses([pkg('a', 'MIT'), pkg('b', 'Apache-2.0')], deny), []);
    assert.deepEqual(checkDependencyLicenses([], deny), []);
  });

  it('returns only the denied packages with name, version and SPDX ID', () => {
    const result = checkDependencyLicenses([pkg('a', 'MIT'), pkg('b', 'GPL-3.0-only', '2.0'), pkg('c', 'AGPL-3.0-only')], deny);
    assert.deepEqual(result, [
      { name: 'b', version: '2.0', spdxId: 'GPL-3.0-only' },
      { name: 'c', version: '1.0.0', spdxId: 'AGPL-3.0-only' },
    ]);
  });

  it('skips packages without license information and defaults missing name/version', () => {
    assert.deepEqual(checkDependencyLicenses([pkg('a', 'NOASSERTION'), pkg('b', 'NONE'), pkg('c', null)], deny), []);
    assert.deepEqual(checkDependencyLicenses([{ licenseDeclared: 'GPL-3.0-only' }], deny), [{ name: '', version: '', spdxId: 'GPL-3.0-only' }]);
  });
});

describe('summarizeLicenses', () => {
  it('counts packages, unique licenses and packages without a license', () => {
    const summary = summarizeLicenses([pkg('a', 'MIT'), pkg('b', 'MIT'), pkg('c', 'Apache-2.0'), pkg('d', 'NOASSERTION'), pkg('e', null)]);
    assert.deepEqual(summary, { packageCount: 5, uniqueLicenseCount: 2, noLicenseCount: 2 });
  });
});

// ── fetchSbomPackages ─────────────────────────────────────────────────────────

describe('fetchSbomPackages', () => {
  const gh = createFakeGitHub({ sbomUrls: { repo: 'https://api.example/sbom-report' } });
  const fetchFor = (fetch, extra = {}) => fetchSbomPackages(gh, org, 'repo', { token: 'tok', fetch, sleep: noSleep, ...extra });

  it('returns packages from sbom.packages after a 302, with auth headers on the poll', async () => {
    const fetch = sbomFetch([302], { sbom: { packages: [pkg('a', 'MIT')] } });
    const result = await fetchFor(fetch);
    assert.deepEqual(result, { packages: [pkg('a', 'MIT')], pollAttempts: 1 });
    const [poll] = fetch.calls;
    assert.equal(poll.options.headers.Authorization, 'Bearer tok');
    assert.equal(poll.options.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(poll.options.redirect, 'manual');
  });

  it('accepts top-level packages and a document without packages', async () => {
    assert.deepEqual((await fetchFor(sbomFetch([302], { packages: [pkg('x', 'MIT')] }))).packages, [pkg('x', 'MIT')]);
    assert.deepEqual((await fetchFor(sbomFetch([302], {}))).packages, []);
  });

  it('polls again after 202 and after a single 5xx', async () => {
    const sleeps = [];
    const result = await fetchFor(sbomFetch([202, 502, 302]), { sleep: async ms => sleeps.push(ms) });
    assert.equal(result.pollAttempts, 3);
    assert.deepEqual(sleeps, [400, 2000, 2000]);
  });

  it('throws when the report URL is missing', async () => {
    await assert.rejects(
      () => fetchSbomPackages(createFakeGitHub(), org, 'repo', { token: 't', fetch: sbomFetch([302]), sleep: noSleep }),
      /SBOM report URL missing for test-org\/repo/,
    );
  });

  it('throws when the download fails', async () => {
    await assert.rejects(() => fetchFor(sbomFetch([302], {}, { downloadStatus: 500 })), /SBOM download failed for test-org\/repo: status 500/);
  });

  it('throws after three 5xx responses', async () => {
    await assert.rejects(() => fetchFor(sbomFetch([500])), /3 consecutive 5xx responses/);
  });

  it('throws immediately on an unexpected status', async () => {
    const fetch = sbomFetch([404]);
    await assert.rejects(() => fetchFor(fetch), /status 404/);
    assert.equal(fetch.calls.length, 1);
  });

  it('gives up after the maximum number of polls', async () => {
    const fetch = sbomFetch([202]);
    await assert.rejects(() => fetchFor(fetch), /not ready after 20s\. Giving up\./);
    assert.equal(fetch.calls.length, 10);
  });
});

// ── Issue bodies and output ───────────────────────────────────────────────────

describe('buildIssueBody', () => {
  const violations = [{ name: 'lib', version: '1.2', spdxId: 'GPL-3.0-only' }];

  it('has one row per violation and the attribution line', () => {
    const body = buildIssueBody(violations, { docs_link: '' });
    assert.ok(body.includes('| lib | 1.2 | GPL-3.0-only |'));
    assert.ok(body.includes('_This issue was automatically generated by the OSPO license scanner._'));
  });

  it('links the policy only when docs_link is set', () => {
    assert.ok(buildIssueBody(violations, { docs_link: 'https://policy' }).includes('[License Policy](https://policy)'));
    assert.ok(buildIssueBody(violations, { docs_link: '' }).includes('Please replace or remove the dependencies above.'));
  });
});

describe('buildOspoLicenseIssueBody', () => {
  it('has one row per repository and violation', () => {
    const body = buildOspoLicenseIssueBody([
      { repo: 'r1', violations: [{ name: 'a', version: '1', spdxId: 'GPL-3.0-only' }, { name: 'b', version: '2', spdxId: 'AGPL-3.0-only' }] },
      { repo: 'r2', violations: [{ name: 'c', version: '3', spdxId: 'GPL-3.0-only' }] },
    ]);
    assert.ok(body.startsWith('## License Violation Summary'));
    assert.ok(body.includes('| Repository | Package | Version | License |'));
    assert.ok(body.includes('| r1 | a | 1 | GPL-3.0-only |'));
    assert.ok(body.includes('| r1 | b | 2 | AGPL-3.0-only |'));
    assert.ok(body.includes('| r2 | c | 3 | GPL-3.0-only |'));
  });
});

describe('formatRepoResult', () => {
  const result = {
    repo: 'a-very-long-repository-name',
    summary: { packageCount: 3, uniqueLicenseCount: 2, noLicenseCount: 1 },
    violations: [{ name: 'lib', version: '1.0', spdxId: 'GPL-3.0-only' }],
    pollAttempts: 2,
    seconds: 1.234,
  };

  it('truncates long names and lists violations', () => {
    assert.equal(formatRepoResult(result), '❌ a-very-long-reposito  3 packages, 2 unique licenses\n       Non-compliant: lib@1.0 (GPL-3.0-only)');
  });

  it('adds license gaps and performance with debug', () => {
    const text = formatRepoResult({ ...result, violations: [] }, { debug: true });
    assert.ok(text.startsWith('✅ '));
    assert.ok(text.includes('No license info: 1 packages'));
    assert.ok(text.includes('Performance: 2 poll attempt(s), 1.2s total'));
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('run', () => {
  let configPath;
  before(async () => {
    configPath = await writeConfig('run.yaml', ['issue_title: License Violation', 'deny-licenses: [GPL-3.0-only]', 'excluded_repos: [ospo]']);
  });

  const repos = [
    { name: 'ospo' },
    { name: 'clean' },
    { name: 'dirty' },
    { name: 'fixed' },
    { name: 'no-sbom' },
    { name: 'old', archived: true },
  ];
  const sboms = {
    clean: { sbom: { packages: [pkg('a', 'MIT'), pkg('b', 'Apache-2.0')] } },
    dirty: { sbom: { packages: [pkg('a', 'MIT'), pkg('gpl-lib', 'GPL-3.0-only', '3.1')] } },
    fixed: { sbom: { packages: [pkg('a', 'MIT')] } },
  };
  const issues = { fixed: [{ number: 7, title: 'License Violation', state: 'open' }] };

  /** fetch() that routes poll and download URLs per repo; 'no-sbom' answers 404. */
  function orgFetch() {
    return async url => {
      const [, repo, kind] = url.match(/^https:\/\/sbom\/([^/]+)\/(poll|download)$/);
      if (repo === 'no-sbom') return { status: 404 };
      if (kind === 'poll') return { status: 302, headers: new Map([['location', `https://sbom/${repo}/download`]]) };
      return { ok: true, status: 200, json: async () => sboms[repo] };
    };
  }

  async function runScan(argv, fakeOptions = {}, { debug = false, env = {}, now } = {}) {
    const gh = createFakeGitHub({
      repos,
      issues,
      sbomUrls: Object.fromEntries(repos.map(r => [r.name, `https://sbom/${r.name}/poll`])),
      ...fakeOptions,
    });
    const logger = createMemoryLogger({ debug });
    const code = await run({
      argv: ['--org', org, '--config', configPath, ...argv],
      env: { GITHUB_TOKEN: 'tok', ...env },
      github: gh,
      logger,
      fetch: orgFetch(),
      sleep: noSleep,
      now,
    });
    return { gh, logger, code };
  }

  it('dry-run prints results, skipped repos and the planned issue changes', async t => {
    const { gh, logger, code } = await runScan(['--dry-run']);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    const output = logger.output().replace(/^Config: .*$/m, 'Config: <path>');
    t.assert.snapshot(output);
  });

  it('live run opens, closes and summarises issues', async () => {
    const { gh, logger } = await runScan([]);
    const [dirtyIssue] = gh.state.issues.dirty;
    assert.equal(dirtyIssue.title, 'License Violation');
    assert.match(dirtyIssue.body, /\| gpl-lib \| 3\.1 \| GPL-3\.0-only \|/);

    const [fixedIssue] = gh.state.issues.fixed;
    assert.equal(fixedIssue.state, 'closed');
    assert.deepEqual(fixedIssue.comments, ['_All dependency license violations have been resolved. Closing this issue automatically._']);

    const [summary] = gh.state.issues.ospo;
    assert.equal(summary.title, OSPO_LICENSE_ISSUE_TITLE);
    assert.match(summary.body, /\| dirty \| gpl-lib \| 3\.1 \| GPL-3\.0-only \|/);
    assert.match(logger.output(), /\n\nCreated OSPO summary issue in 'test-org\/ospo'\./);
  });

  it('updates existing issues instead of creating new ones', async () => {
    const { gh, logger } = await runScan([], {
      issues: {
        dirty: [{ number: 3, title: 'License Violation', body: 'old', state: 'open' }],
        ospo: [{ number: 9, title: OSPO_LICENSE_ISSUE_TITLE, body: 'old', state: 'open' }],
      },
    });
    assert.match(gh.state.issues.dirty[0].body, /gpl-lib/);
    assert.match(gh.state.issues.ospo[0].body, /gpl-lib/);
    assert.equal(gh.callsTo('createIssue').length, 0);
    assert.match(logger.output(), /Updated OSPO summary issue #9 in 'test-org\/ospo'\./);
  });

  it('closes the OSPO summary issue once all violations are resolved', async () => {
    const { gh, logger } = await runScan(['--dry-run'], {
      repos: [{ name: 'clean' }],
      issues: { ospo: [{ number: 9, title: OSPO_LICENSE_ISSUE_TITLE, state: 'open' }] },
    });
    assert.deepEqual(gh.writes(), []);
    assert.match(logger.output(), /0 issue would be created, 0 would be updated, 1 would be closed[^\n]*\n  ✔️   close   #9  ospo \(OSPO summary\)/);

    const live = await runScan([], {
      repos: [{ name: 'clean' }],
      issues: { ospo: [{ number: 9, title: OSPO_LICENSE_ISSUE_TITLE, state: 'open' }] },
    });
    assert.equal(live.gh.state.issues.ospo[0].state, 'closed');
    assert.match(live.logger.output(), /Closed OSPO summary issue #9/);
  });

  it('prints license gaps and performance with --debug', async () => {
    const { logger } = await runScan(['--dry-run', '--debug'], {}, { debug: true });
    assert.match(logger.output(), /Performance: 1 poll attempt\(s\)/);
  });

  it('fails when an SBOM cannot be fetched for another reason', async () => {
    await assert.rejects(
      () => runScan([], { repos: [{ name: 'clean' }], sbomUrls: {} }),
      /SBOM report URL missing for test-org\/clean/,
    );
  });

  it('fails with a clear error when the ospo repository does not exist', async () => {
    const failures = { listOpenIssues: (o, repo) => repo === 'ospo' && notFound() };
    await assert.rejects(() => runScan([], { failures }), /repository 'test-org\/ospo' not found/);
  });

  it('requires a token for the SBOM download', async () => {
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath], env: {} }), /GITHUB_TOKEN/);
  });

  it('--json writes one check per active repo, sorted by repo', async t => {
    const file = path.join(tmpDir, 'out', 'license_scan.json');
    const { logger } = await runScan(['--dry-run', '--json', file], {}, {
      env: { GITHUB_SHA: 'abc123' },
      now: new Date('2026-11-03T02:00:00Z'),
    });
    assert.match(logger.output(), /\nJSON written to .*license_scan\.json\n$/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([...new Set(doc.results.map(r => r.repo))], ['clean', 'dirty', 'fixed', 'no-sbom']);
    assert.ok(doc.results.every(r => r.check in doc.catalogue && r.reason));
    t.assert.snapshot({ ...doc, config_file: '<config>' });
  });
});

describe('JSON output', () => {
  const catalogue = buildCatalogue({ sha: 'abc' });

  it('documents its only check in the spec (SBOM availability is by construction)', () => {
    assert.deepEqual(Object.keys(catalogue), ['license/denied-licenses']);
    assert.equal(
      catalogue['license/denied-licenses'].documentation.url,
      'https://github.com/allianz/ospo/blob/abc/scripts/spec/license_scan_spec.md#dependency-licenses',
    );
  });

  it('maps a missing SBOM to na, and violations to details', () => {
    const scanned = [
      { repo: 'z', packageCount: 3, violations: [{ name: 'a', version: '1', spdxId: 'GPL-3.0' }, { name: 'b', version: '2', spdxId: 'AGPL-3.0' }] },
      { repo: 'm', noSbom: true },
      { repo: 'a', packageCount: 1, violations: [{ name: 'c', version: '3', spdxId: 'GPL-2.0' }] },
    ];
    const { results, skipped } = buildJsonResults({ scanned, archived: [{ name: 'old' }], excluded: [{ name: 'ospo' }], catalogue });
    assert.deepEqual(results.map(r => [r.repo, r.check, r.result, r.reason, r.details]), [
      ['a', 'license/denied-licenses', 'fail', '1 dependency uses a denied license', ['Warn: c@3 (GPL-2.0)']],
      ['m', 'license/denied-licenses', 'na', 'No SBOM available (request returned 404)', []],
      ['z', 'license/denied-licenses', 'fail', '2 dependencies use a denied license', ['Warn: a@1 (GPL-3.0)', 'Warn: b@2 (AGPL-3.0)']],
    ]);
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: 'ospo', reason: 'excluded_repos' }]);
  });
});
