import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  NOT_READABLE, RELEASE_NOTES, TOOL, VERSIONING,
  buildCatalogue, buildJsonResults, compareVersions, evaluateReleaseNotes, evaluateVersioning,
  loadConfig, mentionsVersion, parseVersion, readChangelog, releasesInWindow, run,
} from '../releases_check.js';
import { createFakeGitHub, notFound } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-03T02:00:00Z');
const SINCE = new Date('2025-11-03T02:00:00Z');
const NOTES = 'Bug fixes and a security fix for CVE-2026-1234 in the request parser.';

/** A published release. */
function release(tag, published, { body = NOTES, draft = false } = {}) {
  return { tag_name: tag, published_at: draft ? null : published, body, draft };
}

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'releases-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

async function writeConfig(name, lines) {
  const file = path.join(tmpDir, name);
  await writeFile(file, lines.join('\n'));
  return file;
}

// ── Config ───────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('fills in the defaults, also for an empty file', async () => {
    const config = await loadConfig(await writeConfig('empty.yaml', ['# only a comment']));
    assert.deepEqual(config, { lookback: '12 months', min_notes_chars: 50, excluded_repos: [] });
  });

  it('keeps configured values', async () => {
    const config = await loadConfig(await writeConfig('set.yaml', ['excluded_repos: [legacy]', 'min_notes_chars: 20', 'lookback: "6 months"']));
    assert.deepEqual(config, { lookback: '6 months', min_notes_chars: 20, excluded_repos: ['legacy'] });
  });

  it('rejects an invalid lookback', async () => {
    const file = await writeConfig('bad-lookback.yaml', ['lookback: soon']);
    await assert.rejects(() => loadConfig(file), /Invalid relative date: "soon"/);
  });

  for (const [i, value] of ['0', '"x"', '1.5'].entries()) {
    it(`rejects min_notes_chars: ${value}`, async () => {
      const file = await writeConfig(`bad-min-${i}.yaml`, [`min_notes_chars: ${value}`]);
      await assert.rejects(() => loadConfig(file), /min_notes_chars must be a positive integer/);
    });
  }
});

// ── Versions ─────────────────────────────────────────────────────────────────

describe('parseVersion', () => {
  it('parses SemVer with and without "v", pre-release and build metadata', () => {
    assert.deepEqual(parseVersion('v1.2.3'), { major: 1, nums: [1, 2, 3], pre: [] });
    assert.deepEqual(parseVersion('1.2.3-rc.1+build.5'), { major: 1, nums: [1, 2, 3], pre: ['rc', '1'] });
  });

  it('parses CalVer with two or three parts', () => {
    assert.deepEqual(parseVersion('2026.11'), { major: 2026, nums: [2026, 11, 0], pre: [] });
    assert.deepEqual(parseVersion('v2026.01.2'), { major: 2026, nums: [2026, 1, 2], pre: [] });
  });

  for (const tag of ['release-5', '1', 'v1.2.3.4', '1.2.x', 'V1.2.3', '1.2.3-', '']) {
    it(`rejects "${tag}"`, () => assert.equal(parseVersion(tag), null));
  }
});

describe('compareVersions', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];

  it('follows SemVer precedence', () => {
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(compareVersions(parseVersion(sorted[i - 1]), parseVersion(sorted[i])) < 0, `${sorted[i - 1]} < ${sorted[i]}`);
      assert.ok(compareVersions(parseVersion(sorted[i]), parseVersion(sorted[i - 1])) > 0, `${sorted[i]} > ${sorted[i - 1]}`);
    }
  });

  it('treats equal versions as equal, ignoring "v", build metadata and a missing third part', () => {
    assert.equal(compareVersions(parseVersion('v1.2.3+a'), parseVersion('1.2.3+b')), 0);
    assert.equal(compareVersions(parseVersion('2026.11'), parseVersion('2026.11.0')), 0);
    assert.equal(compareVersions(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0-rc.1')), 0);
  });
});

// ── Checks ───────────────────────────────────────────────────────────────────

describe('releasesInWindow', () => {
  it('drops drafts and releases published before the window, and sorts by publication', () => {
    const releases = releasesInWindow([
      release('v3', '2026-06-01T00:00:00Z'),
      release('draft', null, { draft: true }),
      release('old', '2025-10-01T00:00:00Z'),
      release('v2', '2026-01-01T00:00:00Z'),
    ], SINCE);
    assert.deepEqual(releases.map(r => r.tag_name), ['v2', 'v3']);
  });
});

describe('evaluateVersioning', () => {
  it('passes for increasing versions', () => {
    const result = evaluateVersioning([release('v2.3.0', '2026-01-01T00:00:00Z'), release('v2.4.0', '2026-03-01T00:00:00Z'), release('v2.4.1', '2026-05-01T00:00:00Z')]);
    assert.deepEqual(result, {
      passed: true,
      reason: '3 releases follow SemVer or CalVer, increasing within each major line',
      details: ['Info: releases checked: v2.3.0, v2.4.0, v2.4.1'],
    });
  });

  it('allows backports on an older major line and pre-releases before the release', () => {
    const result = evaluateVersioning([
      release('v2.0.0-rc.1', '2026-01-01T00:00:00Z'),
      release('v2.0.0', '2026-02-01T00:00:00Z'),
      release('v1.9.4', '2026-03-01T00:00:00Z'),
      release('v2.1.0', '2026-04-01T00:00:00Z'),
    ]);
    assert.equal(result.passed, true);
  });

  it('fails when a version goes backwards within a major line, also against an earlier release', () => {
    const result = evaluateVersioning([release('v3.1.0', '2026-01-01T00:00:00Z'), release('v3.0.9', '2026-02-01T00:00:00Z'), release('v3.1.1', '2026-03-01T00:00:00Z')]);
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'version not increasing: v3.0.9 after v3.1.0 in major line 3');
    assert.deepEqual(result.details, [
      'Info: releases checked: v3.1.0, v3.0.9, v3.1.1',
      'Warn: v3.0.9 (2026-02-01) is not higher than v3.1.0 (2026-01-01) in major line 3',
    ]);
  });

  it('fails on the same version released twice under different tags', () => {
    const result = evaluateVersioning([release('1.0.0', '2026-01-01T00:00:00Z'), release('v1.0.0', '2026-02-01T00:00:00Z')]);
    assert.equal(result.reason, 'version not increasing: v1.0.0 after 1.0.0 in major line 1');
  });

  it('fails on tags that are neither SemVer nor CalVer, and reports both problems', () => {
    const result = evaluateVersioning([
      release('v2.0.0', '2026-01-01T00:00:00Z'),
      release('nightly', '2026-02-01T00:00:00Z'),
      release('v1.0.0', '2026-03-01T00:00:00Z'),
      release('v2.0.0-beta', '2026-04-01T00:00:00Z'),
    ]);
    assert.equal(result.passed, false);
    assert.equal(result.reason, '1 of 4 releases not SemVer or CalVer: nightly; version not increasing: v2.0.0-beta after v2.0.0 in major line 2');
    assert.ok(result.details.includes('Warn: nightly (2026-02-01) is not SemVer or CalVer'));
  });

  it('uses the singular for one release', () => {
    assert.equal(evaluateVersioning([release('v1.0.0', '2026-01-01T00:00:00Z')]).reason, '1 release follows SemVer or CalVer, increasing within each major line');
  });
});

describe('mentionsVersion', () => {
  const changelog = '# Changelog\n\n## [2.4.10] - 2026-05-01\n\n## v2.3.0\n\n- see 3.0.0-rc.1\n\nReleased 1.5.0.\n';

  it('finds the version with or without "v"', () => {
    assert.equal(mentionsVersion(changelog, 'v2.4.10'), true);
    assert.equal(mentionsVersion(changelog, '2.3.0'), true);
    assert.equal(mentionsVersion(changelog, 'v1.5.0'), true);
  });

  it('does not match a version that is only part of a longer one', () => {
    assert.equal(mentionsVersion(changelog, 'v2.4.1'), false);
    assert.equal(mentionsVersion(changelog, 'v3.0.0'), false);
    assert.equal(mentionsVersion(changelog, 'v4.10'), false);
  });
});

describe('evaluateReleaseNotes', () => {
  const minChars = 50;

  it('passes on release bodies of at least min_notes_chars characters (trimmed)', () => {
    const exact = 'x'.repeat(50);
    const result = evaluateReleaseNotes([release('v1.0.0', '2026-01-01T00:00:00Z', { body: `  ${exact}\n` })], { minChars });
    assert.deepEqual(result, { passed: true, reason: 'The release has notes (release body)', details: ['Info: v1.0.0 release body (50 characters)'] });
    const short = evaluateReleaseNotes([release('v1.0.0', '2026-01-01T00:00:00Z', { body: 'x'.repeat(49) })], { minChars });
    assert.equal(short.passed, false);
  });

  it('falls back to the changelog for short or empty bodies', () => {
    const changelog = { file: 'CHANGELOG.md', text: '## 1.1.0\n- fix\n' };
    const result = evaluateReleaseNotes([release('v1.0.0', '2026-01-01T00:00:00Z'), release('v1.1.0', '2026-02-01T00:00:00Z', { body: null })], { minChars, changelog });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'All 2 releases have notes (release body or CHANGELOG.md)');
    assert.deepEqual(result.details, ['Info: v1.0.0 release body (69 characters)', 'Info: v1.1.0 mentioned in CHANGELOG.md']);
  });

  it('fails and names the releases without notes', () => {
    const changelog = { file: 'CHANGELOG.md', text: '## 2.4.10\n' };
    const result = evaluateReleaseNotes([release('v2.3.0', '2026-01-01T00:00:00Z'), release('v2.4.1', '2026-02-01T00:00:00Z', { body: 'fix' })], { minChars, changelog });
    assert.equal(result.passed, false);
    assert.equal(result.reason, '1 of 2 releases without notes: v2.4.1');
    assert.equal(result.details[1], 'Warn: v2.4.1 release body has 3 characters (minimum 50), not mentioned in CHANGELOG.md');
    const noFile = evaluateReleaseNotes([release('v2.4.1', '2026-02-01T00:00:00Z', { body: '' })], { minChars });
    assert.deepEqual(noFile.details, ['Warn: v2.4.1 release body has 0 characters (minimum 50), no CHANGELOG file']);
  });
});

describe('readChangelog', () => {
  it('reads the first CHANGELOG* file in the root, case-insensitively', async () => {
    const gh = createFakeGitHub({ files: { r: { 'README.md': '', 'changelog.txt': 'b', 'CHANGELOG.md': 'a', 'docs/CHANGELOG.md': 'c' } } });
    assert.deepEqual(await readChangelog(gh, org, 'r'), { file: 'CHANGELOG.md', text: 'a' });
  });

  it('is null without a file, for an empty repository, or when the file is gone', async () => {
    const gh = createFakeGitHub({
      files: { plain: { 'README.md': '' }, gone: { 'CHANGELOG.md': 'x' } },
      failures: { getFileText: (o, repo) => repo === 'gone' && notFound() },
    });
    assert.equal(await readChangelog(gh, org, 'plain'), null);
    assert.equal(await readChangelog(gh, org, 'empty'), null);
    assert.equal(await readChangelog(gh, org, 'gone'), null);
  });

  it('passes on other API errors', async () => {
    const gh = createFakeGitHub({ failures: { listRootFiles: () => Object.assign(new Error('boom'), { status: 500 }) } });
    await assert.rejects(() => readChangelog(gh, org, 'r'), /boom/);
  });
});

// ── JSON output ──────────────────────────────────────────────────────────────

describe('buildCatalogue', () => {
  const catalogue = buildCatalogue({ lookback: '6 months', minChars: 20, sha: 'abc' });

  it('documents both checks under their spec headings, with the configured values', () => {
    assert.equal(catalogue[VERSIONING].name, 'Versioning');
    assert.equal(catalogue[VERSIONING].documentation.url, 'https://github.com/allianz/ospo/blob/abc/scripts/spec/releases_check_spec.md#versioning');
    assert.match(catalogue[VERSIONING].documentation.short, /published in the last 6 months has a SemVer or CalVer tag/);
    assert.match(catalogue[VERSIONING].documentation.fix, /counts for 6 months/);
    assert.equal(catalogue[RELEASE_NOTES].name, 'Release Notes');
    assert.equal(catalogue[RELEASE_NOTES].documentation.url, 'https://github.com/allianz/ospo/blob/abc/scripts/spec/releases_check_spec.md#release-notes');
    assert.match(catalogue[RELEASE_NOTES].documentation.short, /at least 20 characters/);
  });
});

describe('buildJsonResults', () => {
  it('writes two results per repo sorted by repo, na without releases, two errors per unreadable repo', () => {
    const catalogue = buildCatalogue({ lookback: '12 months', minChars: 50 });
    const { results, skipped, errors } = buildJsonResults({
      evaluated: [
        { repo: 'z', versioning: { passed: false, reason: 'back', details: ['Warn: x'] }, notes: { passed: true, reason: 'ok', details: [] } },
        { repo: 'm', error: NOT_READABLE },
        { repo: 'a', na: true, reason: 'No release in the last 12 months' },
      ],
      archived: [{ name: 'old' }],
      excluded: [{ name: 'legacy' }],
      catalogue,
    });
    assert.deepEqual(results.map(r => [r.repo, r.check, r.result, r.reason, r.details]), [
      ['a', VERSIONING, 'na', 'No release in the last 12 months', []],
      ['a', RELEASE_NOTES, 'na', 'No release in the last 12 months', []],
      ['z', VERSIONING, 'fail', 'back', ['Warn: x']],
      ['z', RELEASE_NOTES, 'pass', 'ok', []],
    ]);
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: 'legacy', reason: 'excluded_repos' }]);
    assert.deepEqual(errors, [{ repo: 'm', check: VERSIONING, reason: NOT_READABLE }, { repo: 'm', check: RELEASE_NOTES, reason: NOT_READABLE }]);
  });
});

// ── run() ────────────────────────────────────────────────────────────────────

describe('run', () => {
  const repos = [
    { name: 'pricing-engine' },
    { name: 'pdf-render-service' },
    { name: 'mobile-sdk-ios' },
    { name: 'design-guidelines' },
    { name: 'old', archived: true },
    { name: 'legacy' },
  ];
  const releases = {
    'pricing-engine': [
      release('v2.3.0', '2026-01-12T10:00:00Z'),
      release('v2.4.0', '2026-04-02T10:00:00Z', { body: 'short' }),
      release('v2.4.1', '2026-08-20T10:00:00Z'),
      release('v2.5.0', null, { draft: true }),
    ],
    'pdf-render-service': [
      release('v1.7.0', '2026-02-01T09:00:00Z'),
      release('v1.8.0', '2026-07-15T09:00:00Z', { body: '' }),
    ],
    'mobile-sdk-ios': [
      release('v3.1.0', '2026-03-01T08:00:00Z'),
      release('v3.0.9', '2026-05-01T08:00:00Z'),
      release('v3.1.1', '2026-09-01T08:00:00Z'),
    ],
    'design-guidelines': [release('v1.0.0', '2024-05-01T00:00:00Z')],
  };
  const files = {
    'pricing-engine': { 'CHANGELOG.md': '# Changelog\n\n## 2.4.0\n- new tariff\n', 'README.md': '' },
    'pdf-render-service': { 'README.md': '' },
  };
  let configPath;
  before(async () => { configPath = await writeConfig('releases_check.yaml', ['excluded_repos: [legacy]']); });

  async function runCheck(argv, { debug = false, env, fakeOptions = {} } = {}) {
    const gh = createFakeGitHub({ repos, releases, files, ...fakeOptions });
    const logger = createMemoryLogger({ debug });
    const code = await run({ argv: ['--org', org, '--config', configPath, ...argv], github: gh, logger, env, now: NOW });
    return { gh, logger, code };
  }

  it('logs findings and writes nothing to GitHub', async t => {
    const { gh, logger, code } = await runCheck(['--json', path.join(tmpDir, 'out', 'log.json')]);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    assert.doesNotMatch(logger.output(), /design-guidelines|pricing-engine/);
    t.assert.snapshot(logger.output().replace(tmpDir, '<tmp>'));
  });

  it('reads the changelog only for repos with a short release body', async () => {
    const { gh } = await runCheck(['--json', path.join(tmpDir, 'out', 'calls.json')]);
    assert.deepEqual(gh.callsTo('listRootFiles').map(c => c.args[1]).sort(), ['pdf-render-service', 'pricing-engine']);
    assert.deepEqual(gh.callsTo('getFileText').map(c => c.args.slice(1)), [['pricing-engine', 'CHANGELOG.md']]);
  });

  it('--debug also lists passing checks and repos without releases', async () => {
    const { logger } = await runCheck(['--debug', '--json', path.join(tmpDir, 'out', 'debug.json')], { debug: true });
    assert.match(logger.output(), /Releases published since 2025-11-03T02:00:00.000Z, release notes of at least 50 characters/);
    assert.match(logger.output(), / {2}design-guidelines: No release in the last 12 months\n/);
    assert.match(logger.output(), / {2}pricing-engine: release notes: All 3 releases have notes \(release body or CHANGELOG\.md\)\n/);
  });

  it('says so when all releases pass', async () => {
    const { logger } = await runCheck(['--json', path.join(tmpDir, 'out', 'ok.json')], { fakeOptions: { releases: { 'pricing-engine': releases['pricing-engine'] } } });
    assert.match(logger.output(), /\nReleasing repositories: 1\nAll releases versioned and documented\.\n/);
  });

  it('writes two results per active repo as JSON', async t => {
    const file = path.join(tmpDir, 'out', 'releases_check.json');
    const { logger } = await runCheck(['--json', file], { env: { GITHUB_SHA: 'abc123' } });
    assert.match(logger.output(), /\nJSON written to .*releases_check\.json\n$/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.tool, TOOL);
    assert.equal(doc.issue_title, null);
    assert.deepEqual(doc.results.map(r => [r.repo, r.check, r.result]), [
      ['design-guidelines', VERSIONING, 'na'], ['design-guidelines', RELEASE_NOTES, 'na'],
      ['mobile-sdk-ios', VERSIONING, 'fail'], ['mobile-sdk-ios', RELEASE_NOTES, 'pass'],
      ['pdf-render-service', VERSIONING, 'pass'], ['pdf-render-service', RELEASE_NOTES, 'fail'],
      ['pricing-engine', VERSIONING, 'pass'], ['pricing-engine', RELEASE_NOTES, 'pass'],
    ]);
    assert.ok(doc.results.every(r => r.check in doc.catalogue));
    t.assert.snapshot({ ...doc, config_file: '<config>' });
  });

  it('requires --json and makes no API call without it', async () => {
    const gh = createFakeGitHub({ repos });
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath], github: gh }), /--json is required/);
    assert.deepEqual(gh.calls, []);
  });

  it('requires a token without an injected GitHub', async () => {
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath, '--json', 'x.json'], env: {} }), /GITHUB_TOKEN/);
  });

  it('records a repo whose releases return 404 in errors, without results', async () => {
    const file = path.join(tmpDir, 'out', 'not-found.json');
    const failures = { listReleases: (o, repo) => repo === 'design-guidelines' && notFound() };
    const { logger } = await runCheck(['--json', file], { fakeOptions: { failures } });
    assert.match(logger.output(), / {2}design-guidelines: Releases not readable .*\n/);
    assert.match(logger.output(), /\nNot readable \(in errors\): 1 repository\n/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(!doc.results.some(r => r.repo === 'design-guidelines'));
    assert.deepEqual(doc.errors, [
      { repo: 'design-guidelines', check: VERSIONING, reason: NOT_READABLE },
      { repo: 'design-guidelines', check: RELEASE_NOTES, reason: NOT_READABLE },
    ]);
  });

  it('aborts on any other API error and writes no file', async () => {
    const file = path.join(tmpDir, 'out', 'failed.json');
    const failures = { listReleases: (o, repo) => repo === 'mobile-sdk-ios' && Object.assign(new Error('boom'), { status: 500 }) };
    await assert.rejects(() => runCheck(['--json', file], { fakeOptions: { failures } }), /boom/);
    await assert.rejects(() => access(file));
  });
});
