import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ADVISORIES, ADVISORIES_NOT_READABLE, BY_CONSTRUCTION, RELEASES_NOT_READABLE, RELEASE_NOTES, TOOL, VERSIONING,
  buildCatalogue, buildJsonResults, compareVersions, evaluateAdvisories, evaluateReleaseNotes, evaluateVersioning,
  loadConfig, mentionsVersion, parseVersion, readChangelog, releasesInWindow, run,
} from '../process_check.js';
import { createFakeGitHub, notFound } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-03T02:00:00Z');
const SINCE = new Date('2025-11-03T02:00:00Z');
const NOTES = 'Bug fixes and a security fix for CVE-2026-1234 in the request parser.';
const SOURCE_ARCHIVES = 'by-construction/source-archives';
const SBOM_AVAILABLE = 'by-construction/sbom-available';
const advisoryOptions = { since: SINCE, maxDays: 90, lookback: '12 months' };

/** An advisory created `days` days before it was published. */
function advisory(id, published, days, state = 'published') {
  const created = new Date(new Date(published).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { ghsa_id: id, created_at: created, published_at: published, state };
}

/** A published release. */
function release(tag, published, { body = NOTES, draft = false } = {}) {
  return { tag_name: tag, published_at: draft ? null : published, body, draft };
}

const boom = () => Object.assign(new Error('boom'), { status: 500 });

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'process-check-test-')); });
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
    assert.deepEqual(config, {
      excluded_repos: [],
      advisories: { max_days: 90, lookback: '12 months' },
      releases: { lookback: '12 months', min_notes_chars: 50 },
    });
  });

  it('keeps configured values and fills in the rest of a section', async () => {
    const config = await loadConfig(await writeConfig('set.yaml', [
      'excluded_repos: [legacy]',
      'advisories:',
      '  max_days: 30',
      'releases:',
      '  lookback: "6 months"',
      '  min_notes_chars: 20',
    ]));
    assert.deepEqual(config, {
      excluded_repos: ['legacy'],
      advisories: { max_days: 30, lookback: '12 months' },
      releases: { lookback: '6 months', min_notes_chars: 20 },
    });
  });

  for (const section of ['advisories', 'releases']) {
    it(`rejects an invalid ${section}.lookback`, async () => {
      const file = await writeConfig(`bad-lookback-${section}.yaml`, [`${section}:`, '  lookback: soon']);
      await assert.rejects(() => loadConfig(file), /Invalid relative date: "soon"/);
    });

    it(`rejects ${section} that is not a mapping`, async () => {
      const file = await writeConfig(`bad-section-${section}.yaml`, [`${section}: [1]`]);
      await assert.rejects(() => loadConfig(file), new RegExp(`Config field ${section} must be a mapping`));
    });
  }

  for (const field of ['advisories.max_days', 'releases.min_notes_chars']) {
    for (const [i, value] of ['0', '"x"', '1.5'].entries()) {
      it(`rejects ${field}: ${value}`, async () => {
        const [section, key] = field.split('.');
        const file = await writeConfig(`bad-${key}-${i}.yaml`, [`${section}:`, `  ${key}: ${value}`]);
        await assert.rejects(() => loadConfig(file), new RegExp(`Config field ${field.replace('.', '\\.')} must be a positive integer`));
      });
    }
  }
});

// ── Advisories ───────────────────────────────────────────────────────────────

describe('evaluateAdvisories', () => {
  it('passes without advisories', () => {
    assert.deepEqual(evaluateAdvisories([], advisoryOptions), {
      passed: true, count: 0, reason: 'No advisory published in the last 12 months', details: [],
    });
  });

  it('ignores advisories published before the lookback window, even late ones', () => {
    const result = evaluateAdvisories([advisory('GHSA-old', '2025-10-01T00:00:00Z', 400)], advisoryOptions);
    assert.equal(result.passed, true);
    assert.equal(result.count, 0);
  });

  it('passes at exactly max_days and fails one day later', () => {
    const atLimit = evaluateAdvisories([advisory('GHSA-a', '2026-06-01T00:00:00Z', 90)], advisoryOptions);
    assert.equal(atLimit.passed, true);
    assert.equal(atLimit.reason, '1 advisory published in the last 12 months: GHSA-a after 90 days');
    const late = evaluateAdvisories([advisory('GHSA-a', '2026-06-01T00:00:00Z', 91)], advisoryOptions);
    assert.equal(late.passed, false);
    assert.equal(late.reason, '1 of 1 advisory published later than 90 days: GHSA-a after 91 days');
  });

  it('counts whole days only', () => {
    const published = '2026-06-01T00:00:00Z';
    const created = new Date(new Date(published).getTime() - (90 * 24 + 23) * 60 * 60 * 1000).toISOString();
    assert.equal(evaluateAdvisories([{ ghsa_id: 'GHSA-h', created_at: created, published_at: published }], advisoryOptions).passed, true);
  });

  it('lists all advisories by publication date and fails on a late one', () => {
    const result = evaluateAdvisories([
      advisory('GHSA-late', '2026-09-10T00:00:00Z', 120),
      advisory('GHSA-fast', '2026-02-01T00:00:00Z', 1),
    ], advisoryOptions);
    assert.equal(result.passed, false);
    assert.equal(result.count, 2);
    assert.equal(result.reason, '1 of 2 advisories published later than 90 days: GHSA-late after 120 days');
    assert.deepEqual(result.details, [
      'Info: GHSA-fast created 2026-01-31, published 2026-02-01 (1 day)',
      'Warn: GHSA-late created 2026-05-13, published 2026-09-10 (120 days)',
    ]);
  });

  it('names every advisory in the reason when all are in time', () => {
    const result = evaluateAdvisories([advisory('GHSA-b', '2026-08-01T00:00:00Z', 41), advisory('GHSA-a', '2026-03-01T00:00:00Z', 18)], advisoryOptions);
    assert.equal(result.reason, '2 advisories published in the last 12 months: GHSA-a after 18 days, GHSA-b after 41 days');
  });
});

// ── Releases: versions ───────────────────────────────────────────────────────

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

// ── Releases: checks ─────────────────────────────────────────────────────────

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
  const catalogue = buildCatalogue({
    advisories: { max_days: 30, lookback: '9 months' },
    releases: { lookback: '6 months', min_notes_chars: 20 },
    sha: 'abc',
  });
  const spec = 'https://github.com/allianz/ospo/blob/abc/scripts/spec/process_check_spec.md';

  it('lists all checks, each under its spec heading, pinned to the sha', () => {
    assert.deepEqual(Object.entries(catalogue).map(([id, e]) => [id, e.name, e.documentation.url]), [
      [ADVISORIES, 'Advisories Published in Time', `${spec}#advisories-published-in-time`],
      [SOURCE_ARCHIVES, 'Source Archives', `${spec}#source-archives`],
      [SBOM_AVAILABLE, 'SBOM Available', `${spec}#sbom-available`],
      [VERSIONING, 'Versioning', `${spec}#versioning`],
      [RELEASE_NOTES, 'Release Notes', `${spec}#release-notes`],
    ]);
  });

  it('puts the configured values into the advisories rule and fix', () => {
    const { documentation } = catalogue[ADVISORIES];
    assert.match(documentation.short, /in the last 9 months was published within 30 days of its creation/);
    assert.match(documentation.fix, /within 30 days .* counts for 9 months/);
  });

  it('puts the configured values into the release rules and fixes', () => {
    assert.match(catalogue[VERSIONING].documentation.short, /published in the last 6 months has a SemVer or CalVer tag/);
    assert.match(catalogue[VERSIONING].documentation.fix, /counts for 6 months/);
    assert.match(catalogue[RELEASE_NOTES].documentation.short, /at least 20 characters/);
  });

  it('says that the by-construction checks are no tests and gives them no fix', () => {
    for (const id of Object.keys(BY_CONSTRUCTION)) {
      assert.match(catalogue[id].documentation.short, /^Not a test; always passes\. /);
      assert.equal(JSON.parse(JSON.stringify(catalogue[id])).documentation.fix, undefined);
    }
  });

  it('uses the defaults and pins to main without arguments', () => {
    const defaults = buildCatalogue();
    assert.match(defaults[ADVISORIES].documentation.short, /in the last 12 months was published within 90 days/);
    assert.match(defaults[SBOM_AVAILABLE].documentation.url, /\/blob\/main\//);
  });
});

describe('buildJsonResults', () => {
  const catalogue = buildCatalogue();
  const ok = { passed: true, reason: 'ok', details: [] };

  it('sorts by repo, then in catalogue order, with na without releases and errors per family', () => {
    const { results, skipped, errors } = buildJsonResults({
      evaluated: [
        { repo: 'z', advisories: { passed: false, reason: 'late', details: ['Warn: x'] }, releases: { versioning: { passed: false, reason: 'back', details: [] }, notes: ok } },
        { repo: 'm', advisories: { error: ADVISORIES_NOT_READABLE }, releases: { error: RELEASES_NOT_READABLE } },
        { repo: 'a', advisories: ok, releases: { na: true, reason: 'No release in the last 12 months' } },
      ],
      archived: [{ name: 'old' }],
      excluded: [{ name: 'legacy' }],
      catalogue,
    });
    assert.deepEqual(results.map(r => [r.repo, r.check, r.result, r.reason]), [
      ['a', ADVISORIES, 'pass', 'ok'],
      ['a', SOURCE_ARCHIVES, 'pass', BY_CONSTRUCTION[SOURCE_ARCHIVES].reason],
      ['a', SBOM_AVAILABLE, 'pass', BY_CONSTRUCTION[SBOM_AVAILABLE].reason],
      ['a', VERSIONING, 'na', 'No release in the last 12 months'],
      ['a', RELEASE_NOTES, 'na', 'No release in the last 12 months'],
      ['m', SOURCE_ARCHIVES, 'pass', BY_CONSTRUCTION[SOURCE_ARCHIVES].reason],
      ['m', SBOM_AVAILABLE, 'pass', BY_CONSTRUCTION[SBOM_AVAILABLE].reason],
      ['z', ADVISORIES, 'fail', 'late'],
      ['z', SOURCE_ARCHIVES, 'pass', BY_CONSTRUCTION[SOURCE_ARCHIVES].reason],
      ['z', SBOM_AVAILABLE, 'pass', BY_CONSTRUCTION[SBOM_AVAILABLE].reason],
      ['z', VERSIONING, 'fail', 'back'],
      ['z', RELEASE_NOTES, 'pass', 'ok'],
    ]);
    assert.deepEqual(results.find(r => r.repo === 'z' && r.check === ADVISORIES).details, ['Warn: x']);
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: 'legacy', reason: 'excluded_repos' }]);
    assert.deepEqual(errors, [
      { repo: 'm', check: ADVISORIES, reason: ADVISORIES_NOT_READABLE },
      { repo: 'm', check: VERSIONING, reason: RELEASES_NOT_READABLE },
      { repo: 'm', check: RELEASE_NOTES, reason: RELEASES_NOT_READABLE },
    ]);
  });

  it('writes no results without active repos', () => {
    assert.deepEqual(buildJsonResults({ evaluated: [], archived: [], excluded: [], catalogue }), { results: [], skipped: [], errors: [] });
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
  const advisories = {
    'pricing-engine': [advisory('GHSA-7q4x-2m9c-h3vf', '2026-05-20T10:00:00Z', 18), advisory('GHSA-draft', '2026-06-01T00:00:00Z', 200, 'draft')],
    'pdf-render-service': [advisory('GHSA-p2w8-xr6j-9cq4', '2026-08-02T08:00:00Z', 130)],
  };
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
  before(async () => { configPath = await writeConfig('process_check.yaml', ['excluded_repos: [legacy]']); });

  async function runCheck(argv, { debug = false, env, fakeOptions = {} } = {}) {
    const gh = createFakeGitHub({ repos, advisories, releases, files, ...fakeOptions });
    const logger = createMemoryLogger({ debug });
    const code = await run({ argv: ['--org', org, '--config', configPath, ...argv], github: gh, logger, env, now: NOW });
    return { gh, logger, code };
  }

  it('logs the findings per family and writes nothing to GitHub', async t => {
    const { gh, logger, code } = await runCheck(['--json', path.join(tmpDir, 'out', 'log.json')]);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    assert.doesNotMatch(logger.output(), /design-guidelines|Unexpected/);
    t.assert.snapshot(logger.output().replace(tmpDir, '<tmp>'));
  });

  it('reads the changelog only for repos with a short release body', async () => {
    const { gh } = await runCheck(['--json', path.join(tmpDir, 'out', 'calls.json')]);
    assert.deepEqual(gh.callsTo('listRootFiles').map(c => c.args[1]).sort(), ['pdf-render-service', 'pricing-engine']);
    assert.deepEqual(gh.callsTo('getFileText').map(c => c.args.slice(1)), [['pricing-engine', 'CHANGELOG.md']]);
  });

  it('--debug also lists passing checks and repos without advisories or releases', async () => {
    const { logger } = await runCheck(['--debug', '--json', path.join(tmpDir, 'out', 'debug.json')], { debug: true });
    const output = logger.output();
    assert.match(output, /Advisories:\nAdvisories published since 2025-11-03T02:00:00.000Z, at most 90 days after creation\n/);
    assert.match(output, / {2}design-guidelines: No advisory published in the last 12 months\n/);
    assert.match(output, /Releases:\nReleases published since 2025-11-03T02:00:00.000Z, release notes of at least 50 characters\n/);
    assert.match(output, / {2}design-guidelines: No release in the last 12 months\n/);
    assert.match(output, / {2}pricing-engine: release notes: All 3 releases have notes \(release body or CHANGELOG\.md\)\n/);
  });

  it('says so when all advisories and releases pass', async () => {
    const { logger } = await runCheck(['--json', path.join(tmpDir, 'out', 'ok.json')], {
      fakeOptions: { advisories: {}, releases: { 'pricing-engine': releases['pricing-engine'] } },
    });
    assert.match(logger.output(), /\nAll advisories published in time\.\n/);
    assert.match(logger.output(), /\nReleasing repositories: 1\nAll releases versioned and documented\.\n/);
  });

  it('writes the results of all checks per active repo as JSON', async t => {
    const file = path.join(tmpDir, 'out', 'process_check.json');
    const { logger } = await runCheck(['--json', file], { env: { GITHUB_SHA: 'abc123' } });
    assert.match(logger.output(), /\nJSON written to .*process_check\.json\n$/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.tool, TOOL);
    assert.equal(doc.issue_title, null);
    const byCheck = check => doc.results.filter(r => r.check === check).map(r => [r.repo, r.result]);
    assert.deepEqual(byCheck(ADVISORIES), [['design-guidelines', 'pass'], ['mobile-sdk-ios', 'pass'], ['pdf-render-service', 'fail'], ['pricing-engine', 'pass']]);
    assert.deepEqual(byCheck(VERSIONING), [['design-guidelines', 'na'], ['mobile-sdk-ios', 'fail'], ['pdf-render-service', 'pass'], ['pricing-engine', 'pass']]);
    assert.deepEqual(byCheck(RELEASE_NOTES), [['design-guidelines', 'na'], ['mobile-sdk-ios', 'pass'], ['pdf-render-service', 'fail'], ['pricing-engine', 'pass']]);
    assert.equal(byCheck(SOURCE_ARCHIVES).length, 4);
    assert.ok(doc.results.every(r => r.check in doc.catalogue));
    assert.deepEqual(doc.errors, []);
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

  it('records a family that returns 404 in errors, and keeps the other checks of the repo', async () => {
    const file = path.join(tmpDir, 'out', 'not-found.json');
    const failures = {
      listPublishedAdvisories: (o, repo) => repo === 'mobile-sdk-ios' && notFound(),
      listReleases: (o, repo) => repo === 'design-guidelines' && notFound(),
    };
    const { logger, code } = await runCheck(['--json', file], { fakeOptions: { failures } });
    assert.equal(code, 0);
    assert.match(logger.output(), / {2}mobile-sdk-ios: Security advisories not readable .*\n/);
    assert.match(logger.output(), / {2}design-guidelines: Releases not readable .*\n/);
    assert.equal(logger.output().match(/\nNot readable \(in errors\): 1 repository\n/g).length, 2);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(doc.results.filter(r => r.repo === 'design-guidelines').map(r => r.check), [ADVISORIES, SOURCE_ARCHIVES, SBOM_AVAILABLE]);
    assert.deepEqual(doc.results.filter(r => r.repo === 'mobile-sdk-ios').map(r => r.check), [SOURCE_ARCHIVES, SBOM_AVAILABLE, VERSIONING, RELEASE_NOTES]);
    assert.deepEqual(doc.errors, [
      { repo: 'design-guidelines', check: VERSIONING, reason: RELEASES_NOT_READABLE },
      { repo: 'design-guidelines', check: RELEASE_NOTES, reason: RELEASES_NOT_READABLE },
      { repo: 'mobile-sdk-ios', check: ADVISORIES, reason: ADVISORIES_NOT_READABLE },
    ]);
  });

  it('records any other error in errors, keeps the other families and repos, and exits with 1', async () => {
    const file = path.join(tmpDir, 'out', 'failed.json');
    const failures = {
      listPublishedAdvisories: (o, repo) => repo === 'pricing-engine' && boom(),
      getFileText: (o, repo) => repo === 'pricing-engine' && boom(),
    };
    const { logger, code } = await runCheck(['--json', file], { fakeOptions: { failures } });
    assert.equal(code, 1);
    assert.match(logger.output(), /Advisories:\n(?:.*\n)* {2}pricing-engine: Unexpected error: boom\n/);
    assert.match(logger.output(), /Releases:\n(?:.*\n)* {2}pricing-engine: Unexpected error: boom\n/);
    assert.match(logger.output(), /\nUnexpected errors \(in errors\): 2\n\nJSON written to /);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(doc.results.filter(r => r.repo === 'pricing-engine').map(r => r.check), [SOURCE_ARCHIVES, SBOM_AVAILABLE]);
    assert.equal(doc.results.filter(r => r.repo === 'mobile-sdk-ios').length, 5);
    assert.deepEqual(doc.errors, [
      { repo: 'pricing-engine', check: ADVISORIES, reason: 'Unexpected error: boom' },
      { repo: 'pricing-engine', check: VERSIONING, reason: 'Unexpected error: boom' },
      { repo: 'pricing-engine', check: RELEASE_NOTES, reason: 'Unexpected error: boom' },
    ]);
  });
});
