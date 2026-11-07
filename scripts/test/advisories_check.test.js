import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CHECK, NOT_READABLE, TOOL, buildCatalogue, buildJsonResults, evaluateAdvisories, loadConfig, run } from '../advisories_check.js';
import { createFakeGitHub, notFound } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-03T02:00:00Z');
const SINCE = new Date('2025-11-03T02:00:00Z');
const options = { since: SINCE, maxDays: 90, lookback: '12 months' };

/** An advisory created `days` days before it was published. */
function advisory(id, published, days, state = 'published') {
  const created = new Date(new Date(published).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { ghsa_id: id, created_at: created, published_at: published, state };
}

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'advisories-test-')); });
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
    assert.deepEqual(config, { max_days: 90, lookback: '12 months', excluded_repos: [] });
  });

  it('keeps configured values', async () => {
    const config = await loadConfig(await writeConfig('set.yaml', ['excluded_repos: [legacy]', 'max_days: 30', 'lookback: "6 months"']));
    assert.deepEqual(config, { max_days: 30, lookback: '6 months', excluded_repos: ['legacy'] });
  });

  it('rejects an invalid lookback', async () => {
    const file = await writeConfig('bad-lookback.yaml', ['lookback: soon']);
    await assert.rejects(() => loadConfig(file), /Invalid relative date: "soon"/);
  });

  for (const [i, value] of ['0', '"x"', '1.5'].entries()) {
    it(`rejects max_days: ${value}`, async () => {
      const file = await writeConfig(`bad-max-${i}.yaml`, [`max_days: ${value}`]);
      await assert.rejects(() => loadConfig(file), /max_days must be a positive integer/);
    });
  }
});

// ── Check ────────────────────────────────────────────────────────────────────

describe('evaluateAdvisories', () => {
  it('passes without advisories', () => {
    assert.deepEqual(evaluateAdvisories([], options), {
      passed: true, count: 0, reason: 'No advisory published in the last 12 months', details: [],
    });
  });

  it('ignores advisories published before the lookback window, even late ones', () => {
    const result = evaluateAdvisories([advisory('GHSA-old', '2025-10-01T00:00:00Z', 400)], options);
    assert.equal(result.passed, true);
    assert.equal(result.count, 0);
  });

  it('passes at exactly max_days and fails one day later', () => {
    const atLimit = evaluateAdvisories([advisory('GHSA-a', '2026-06-01T00:00:00Z', 90)], options);
    assert.equal(atLimit.passed, true);
    assert.equal(atLimit.reason, '1 advisory published in the last 12 months: GHSA-a after 90 days');
    const late = evaluateAdvisories([advisory('GHSA-a', '2026-06-01T00:00:00Z', 91)], options);
    assert.equal(late.passed, false);
    assert.equal(late.reason, '1 of 1 advisory published later than 90 days: GHSA-a after 91 days');
  });

  it('counts whole days only', () => {
    const published = '2026-06-01T00:00:00Z';
    const created = new Date(new Date(published).getTime() - (90 * 24 + 23) * 60 * 60 * 1000).toISOString();
    assert.equal(evaluateAdvisories([{ ghsa_id: 'GHSA-h', created_at: created, published_at: published }], options).passed, true);
  });

  it('lists all advisories by publication date and fails on a late one', () => {
    const result = evaluateAdvisories([
      advisory('GHSA-late', '2026-09-10T00:00:00Z', 120),
      advisory('GHSA-fast', '2026-02-01T00:00:00Z', 1),
    ], options);
    assert.equal(result.passed, false);
    assert.equal(result.count, 2);
    assert.equal(result.reason, '1 of 2 advisories published later than 90 days: GHSA-late after 120 days');
    assert.deepEqual(result.details, [
      'Info: GHSA-fast created 2026-01-31, published 2026-02-01 (1 day)',
      'Warn: GHSA-late created 2026-05-13, published 2026-09-10 (120 days)',
    ]);
  });

  it('names every advisory in the reason when all are in time', () => {
    const result = evaluateAdvisories([advisory('GHSA-b', '2026-08-01T00:00:00Z', 41), advisory('GHSA-a', '2026-03-01T00:00:00Z', 18)], options);
    assert.equal(result.reason, '2 advisories published in the last 12 months: GHSA-a after 18 days, GHSA-b after 41 days');
  });
});

// ── JSON output ──────────────────────────────────────────────────────────────

describe('buildCatalogue', () => {
  const catalogue = buildCatalogue({ maxDays: 30, lookback: '6 months', sha: 'abc' });

  it('documents the check under its spec heading, with the configured values', () => {
    const { name, documentation } = catalogue[CHECK];
    assert.equal(name, 'Advisories Published in Time');
    assert.equal(documentation.url, 'https://github.com/allianz/ospo/blob/abc/scripts/spec/advisories_check_spec.md#advisories-published-in-time');
    assert.match(documentation.short, /in the last 6 months was published within 30 days of its creation/);
    assert.match(documentation.fix, /within 30 days .* counts for 6 months/);
  });
});

describe('buildJsonResults', () => {
  it('sorts results by repo and lists skipped repos', () => {
    const catalogue = buildCatalogue({ maxDays: 90, lookback: '12 months' });
    const { results, skipped } = buildJsonResults({
      evaluated: [
        { repo: 'z', passed: false, reason: 'late', details: ['Warn: x'] },
        { repo: 'a', passed: true, reason: 'none', details: [] },
      ],
      archived: [{ name: 'old' }],
      excluded: [{ name: 'legacy' }],
      catalogue,
    });
    assert.deepEqual(results.map(r => [r.repo, r.check, r.result, r.reason, r.details]), [
      ['a', CHECK, 'pass', 'none', []],
      ['z', CHECK, 'fail', 'late', ['Warn: x']],
    ]);
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: 'legacy', reason: 'excluded_repos' }]);
  });
});

// ── run() ────────────────────────────────────────────────────────────────────

describe('run', () => {
  const repos = [
    { name: 'pricing-engine' },
    { name: 'pdf-render-service' },
    { name: 'quiet-repo' },
    { name: 'old', archived: true },
    { name: 'legacy' },
  ];
  const advisories = {
    'pricing-engine': [advisory('GHSA-7q4x-2m9c-h3vf', '2026-05-20T10:00:00Z', 18), advisory('GHSA-draft', '2026-06-01T00:00:00Z', 200, 'draft')],
    'pdf-render-service': [advisory('GHSA-p2w8-xr6j-9cq4', '2026-08-02T08:00:00Z', 130)],
  };
  let configPath;
  before(async () => { configPath = await writeConfig('advisories_check.yaml', ['excluded_repos: [legacy]']); });

  async function runCheck(argv, { debug = false, env, fakeOptions = {} } = {}) {
    const gh = createFakeGitHub({ repos, advisories, ...fakeOptions });
    const logger = createMemoryLogger({ debug });
    const code = await run({ argv: ['--org', org, '--config', configPath, ...argv], github: gh, logger, env, now: NOW });
    return { gh, logger, code };
  }

  it('logs repos with advisories and the late count, and writes nothing to GitHub', async t => {
    const { gh, logger, code } = await runCheck(['--json', path.join(tmpDir, 'out', 'log.json')]);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    assert.doesNotMatch(logger.output(), /quiet-repo/);
    t.assert.snapshot(logger.output().replace(tmpDir, '<tmp>'));
  });

  it('--debug also lists repos without advisories', async () => {
    const { logger } = await runCheck(['--debug', '--json', path.join(tmpDir, 'out', 'debug.json')], { debug: true });
    assert.match(logger.output(), /Advisories published since 2025-11-03T02:00:00.000Z, at most 90 days after creation/);
    assert.match(logger.output(), / {2}quiet-repo: No advisory published in the last 12 months\n/);
  });

  it('says so when all advisories were published in time', async () => {
    const { logger } = await runCheck(['--json', path.join(tmpDir, 'out', 'ok.json')], { fakeOptions: { advisories: {} } });
    assert.match(logger.output(), /\nAll advisories published in time\.\n/);
  });

  it('writes one result per active repo as JSON', async t => {
    const file = path.join(tmpDir, 'out', 'advisories_check.json');
    const { logger } = await runCheck(['--json', file], { env: { GITHUB_SHA: 'abc123' } });
    assert.match(logger.output(), /\nJSON written to .*advisories_check\.json\n$/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.tool, TOOL);
    assert.equal(doc.issue_title, null);
    assert.deepEqual(doc.results.map(r => [r.repo, r.result]), [['pdf-render-service', 'fail'], ['pricing-engine', 'pass'], ['quiet-repo', 'pass']]);
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

  it('records a repo whose advisories return 404 in errors, without a result', async () => {
    const file = path.join(tmpDir, 'out', 'not-found.json');
    const failures = { listPublishedAdvisories: (o, repo) => repo === 'quiet-repo' && notFound() };
    const { logger } = await runCheck(['--json', file], { fakeOptions: { failures } });
    assert.match(logger.output(), / {2}quiet-repo: Security advisories not readable .*\n/);
    assert.match(logger.output(), /\nNot readable \(in errors\): 1 repository\n/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(doc.results.map(r => r.repo), ['pdf-render-service', 'pricing-engine']);
    assert.deepEqual(doc.errors, [{ repo: 'quiet-repo', check: CHECK, reason: NOT_READABLE }]);
  });

  it('aborts on any other API error and writes no file', async () => {
    const file = path.join(tmpDir, 'out', 'failed.json');
    const failures = { listPublishedAdvisories: (o, repo) => repo === 'quiet-repo' && Object.assign(new Error('boom'), { status: 500 }) };
    await assert.rejects(() => runCheck(['--json', file], { fakeOptions: { failures } }), /boom/);
    await assert.rejects(() => access(file));
  });
});
