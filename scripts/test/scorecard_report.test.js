import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  INPUT,
  REPORT_KEY,
  TEMPLATE_PATH,
  average,
  buildData,
  computeScope,
  computeSummary,
  dataHealth,
  historyEntry,
  median,
  readInput,
  reportTitle,
  run,
  validateRepositories,
} from '../scorecard_report.js';
import { ScriptError } from '../lib/cli.js';
import { DATA_PLACEHOLDER, TITLE_PLACEHOLDER, loadTemplate } from '../lib/report_html.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-03T02:00:00Z');

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'scorecard-report-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const entry = (name, threshold) => ({ name, threshold, documentation: { url: `https://example.test/checks.md#${name.toLowerCase()}`, short: `${name} rule.` } });
const CATALOGUE = {
  'scorecard/code-review': entry('Code-Review', 7),
  'scorecard/fuzzing': entry('Fuzzing', 10),
  'scorecard/license': entry('License', 10),
};
const row = (repo, check, result, score, details = []) => ({ repo, check, name: CATALOGUE[check].name, result, score, reason: `${check} ${result}`, details });

/** scorecard.json: alpha and beta scanned, gamma failed to scan, old archived, skip excluded. */
function scorecardDoc(extra = {}) {
  return {
    tool: 'scorecard_check',
    run_at: '2026-11-03T01:00:00Z',
    org,
    ospo_sha: 'abc123',
    config_file: 'config/scorecard_check.yaml',
    config_sha256: 'f'.repeat(64),
    run_url: null,
    issue_title: null,
    source: 'scorecard CLI (--format=json --show-details)',
    scorecard_version: 'v5.6.0',
    scorecard_commit: '61e84743356275f6ffca23b1b2f2cb945e19eb96',
    results: [
      row('beta', 'scorecard/code-review', 'fail', 3, ['Warn: 7 of 10 changesets not reviewed']),
      row('beta', 'scorecard/fuzzing', 'na', 0, ['Info: scorecard_check: not applicable, no non-memory-safe language']),
      row('beta', 'scorecard/license', 'pass', 10),
      row('alpha', 'scorecard/code-review', 'pass', 10),
      row('alpha', 'scorecard/fuzzing', 'fail', 0),
      row('alpha', 'scorecard/license', 'pass', 10),
    ],
    catalogue: CATALOGUE,
    skipped: [{ repo: 'old', reason: 'archived' }, { repo: 'skip', reason: 'excluded_repos' }],
    errors: [{ repo: 'gamma', check: 'scorecard/license', reason: 'Scorecard failed (exit code 1): boom' }],
    repositories: [
      { repo: 'beta', commit: 'b'.repeat(40), date: '2026-11-03T01:05:00Z', score: 4.2 },
      { repo: 'alpha', commit: 'a'.repeat(40), date: '2026-11-03T01:02:00Z', score: 8.5 },
    ],
    ...extra,
  };
}

const PREVIOUS = {
  report_id: 'OSPO-SC-2026-10',
  history: [
    { month: '2026-09', average_score: 5, scores: { alpha: 7, beta: 3 } },
    { month: '2026-10', average_score: 5.5, scores: { alpha: 8, beta: 3 } },
  ],
};

async function writeJson(file, doc) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

const HEADER = { run_at: '2026-11-03T02:00:00Z', org, ospo_sha: 'def456', run_url: null };
const okInput = { file: INPUT.file, script: INPUT.script, status: 'ok', sha256: 'x' };

// ── Input ────────────────────────────────────────────────────────────────────

describe('validateRepositories', () => {
  it('accepts a list of repositories with a score', () => {
    assert.deepEqual(validateRepositories(scorecardDoc()), []);
  });

  it('rejects a missing list, entries without repo or score and duplicates', () => {
    assert.deepEqual(validateRepositories({}), ['repositories must be a list']);
    assert.deepEqual(validateRepositories({ repositories: [null, { repo: 'a', score: '1' }, { repo: 'b', score: 1 }, { repo: 'b', score: 2 }] }), [
      'every repositories entry needs repo',
      'repositories: score of a is not a number',
      'repositories: b is listed twice',
    ]);
  });
});

describe('readInput', () => {
  it('reads a valid file with its header fields and counts', async () => {
    const dir = path.join(tmpDir, 'input-ok');
    await writeJson(path.join(dir, 'scorecard.json'), scorecardDoc());
    const { input, doc } = await readInput(dir, org);
    assert.equal(doc.tool, 'scorecard_check');
    assert.deepEqual(Object.keys(input), [
      'file', 'script', 'status', 'sha256', 'tool', 'run_at', 'ospo_sha', 'config_file', 'config_sha256', 'run_url',
      'source', 'scorecard_version', 'scorecard_commit', 'counts',
    ]);
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(input.counts, { results: 6, skipped: 2, errors: 1, repositories: 2 });
  });

  it('marks a missing file', async () => {
    assert.deepEqual(await readInput(path.join(tmpDir, 'input-none'), org), {
      input: { file: 'scorecard.json', script: 'scripts/scorecard_check.js', status: 'missing', sha256: null },
      doc: null,
    });
  });

  it('marks a file that is not JSON, of another org or without repositories as invalid', async () => {
    const dir = path.join(tmpDir, 'input-bad');
    await writeJson(path.join(dir, 'scorecard.json'), '{');
    assert.match((await readInput(dir, org)).input.problems[0], /^not valid JSON: /);
    await writeJson(path.join(dir, 'scorecard.json'), scorecardDoc({ org: 'other' }));
    assert.deepEqual((await readInput(dir, org)).input.problems, ["org is 'other', expected 'test-org'"]);
    const { repositories: _r, ...rest } = scorecardDoc();
    await writeJson(path.join(dir, 'scorecard.json'), rest);
    const { input, doc } = await readInput(dir, org);
    assert.equal(input.status, 'invalid');
    assert.deepEqual(input.problems, ['repositories must be a list']);
    assert.equal(doc, null);
  });

  it('throws on read errors other than a missing file', async () => {
    const dir = path.join(tmpDir, 'input-dir');
    await mkdir(path.join(dir, 'scorecard.json'), { recursive: true });
    await assert.rejects(() => readInput(dir, org), /EISDIR/);
  });
});

// ── Compute ──────────────────────────────────────────────────────────────────

describe('computeScope', () => {
  it('collects active repositories from results, repositories, skipped and errors; archived from skip reasons', () => {
    assert.deepEqual(computeScope(scorecardDoc()), { active: ['alpha', 'beta', 'gamma', 'skip'], archived: ['old'] });
  });
});

describe('average and median', () => {
  it('round to one decimal and are null without values', () => {
    assert.equal(average([4.2, 8.5, 5]), 5.9);
    assert.equal(average([]), null);
    assert.equal(median([9, 1, 4]), 4);
    assert.equal(median([4.2, 8.5]), 6.4);
    assert.equal(median([]), null);
  });
});

describe('computeSummary', () => {
  it('counts scanned repositories, scores, results, findings and errors', () => {
    const doc = scorecardDoc();
    assert.deepEqual(computeSummary({ scope: computeScope(doc), repositories: doc.repositories, results: doc.results, errors: doc.errors }), {
      repositories_active: 4,
      repositories_scanned: 2,
      average_score: 6.4,
      median_score: 6.4,
      checks_passed: 3,
      checks_failed: 2,
      checks_na: 1,
      repositories_with_findings: 2,
      repositories_with_errors: 1,
    });
  });
});

describe('historyEntry', () => {
  it('holds the average and the score per repository', () => {
    assert.deepEqual(historyEntry('2026-11', { average_score: 6.4 }, [{ repo: 'a', score: 1 }]), { month: '2026-11', average_score: 6.4, scores: { a: 1 } });
  });
});

describe('buildData', () => {
  it('copies all checks with reason and details, sorted repositories and the history', () => {
    const data = buildData({ input: okInput, doc: scorecardDoc(), previous: { month: '2026-10', path: 'reports/2026-10/scorecard-data.json', doc: PREVIOUS }, header: HEADER });
    assert.equal(data.report_id, 'OSPO-SC-2026-11');
    assert.deepEqual(data.previous_report, { report_id: 'OSPO-SC-2026-10', data_url: 'https://github.com/allianz/ospo/blob/main/reports/2026-10/scorecard-data.json' });
    assert.deepEqual(data.repositories.map(r => r.repo), ['alpha', 'beta']);
    assert.deepEqual(data.results[0], { repo: 'beta', check: 'scorecard/code-review', result: 'fail', score: 3, reason: 'scorecard/code-review fail', details: ['Warn: 7 of 10 changesets not reviewed'] });
    assert.deepEqual(data.history.map(e => [e.month, e.average_score]), [['2026-09', 5], ['2026-10', 5.5], ['2026-11', 6.4]]);
    assert.deepEqual(data.history.at(-1).scores, { alpha: 8.5, beta: 4.2 });
    assert.deepEqual(data.catalogue, CATALOGUE);
  });

  it('drops archived repositories and fills missing optional fields', () => {
    const doc = scorecardDoc({
      results: [{ repo: 'old', check: 'scorecard/license', result: 'pass', score: 10, reason: 'x', details: [] }, { repo: 'alpha', check: 'scorecard/license', result: 'na' }],
      repositories: [{ repo: 'old', score: 1 }, { repo: 'alpha', score: 2 }],
      errors: [{ reason: 'run failed' }],
    });
    const data = buildData({ input: okInput, doc, previous: null, header: HEADER });
    assert.deepEqual(data.repositories, [{ repo: 'alpha', commit: null, date: null, score: 2 }]);
    assert.deepEqual(data.results, [{ repo: 'alpha', check: 'scorecard/license', result: 'na', score: null, reason: '', details: [] }]);
    assert.deepEqual(data.errors, [{ repo: null, check: null, reason: 'run failed' }]);
    assert.equal(data.previous_report, null);
  });

  it('is an empty report with a null average for a missing input, and keeps the earlier history', () => {
    const data = buildData({ input: { ...okInput, status: 'missing', sha256: null }, doc: null, previous: { path: 'p', doc: { history: PREVIOUS.history } }, header: HEADER });
    assert.deepEqual(data.scope, { active: [], archived: [] });
    assert.deepEqual([data.results, data.repositories, data.skipped, data.errors, data.catalogue], [[], [], [], [], {}]);
    assert.equal(data.summary.average_score, null);
    assert.deepEqual(data.history.at(-1), { month: '2026-11', average_score: null, scores: {} });
    assert.equal(data.previous_report.report_id, null);
    assert.deepEqual(dataHealth(data), ['data health: scorecard.json missing']);
  });
});

describe('dataHealth', () => {
  it('warns about errors', () => {
    assert.deepEqual(dataHealth({ input: okInput, errors: [{}] }), ['data health: 1 error (no data)']);
    assert.deepEqual(dataHealth({ input: okInput, errors: [{}, {}] }), ['data health: 2 errors (no data)']);
    assert.deepEqual(dataHealth({ input: okInput, errors: [] }), []);
  });
});

describe('reportTitle', () => {
  it('names organisation and month', () => {
    assert.equal(reportTitle({ org: 'allianz', run_at: '2026-11-03T02:00:00Z' }), 'OpenSSF Scorecard Report · allianz · 2026-11');
  });
});

// ── run ──────────────────────────────────────────────────────────────────────

describe('run', () => {
  async function runReport(name, { argv = [], debug = false, previous = true, doc = scorecardDoc() } = {}) {
    const dir = path.join(tmpDir, name);
    await mkdir(dir, { recursive: true });
    if (doc) await writeJson(path.join(dir, 'scorecard.json'), doc);
    const reports = path.join(tmpDir, `${name}-reports`);
    if (previous) {
      await writeJson(path.join(reports, '2026-10', 'scorecard-data.json'), PREVIOUS);
      await writeJson(path.join(reports, '2026-10', 'bsi-data.json'), { report_id: 'other' });
    }
    const logger = createMemoryLogger({ debug });
    const code = await run({
      argv: ['--org', org, '--dir', dir, '--reports', reports, ...argv],
      env: { GITHUB_SHA: 'abc123', GITHUB_REPOSITORY: 'allianz/ospo', GITHUB_RUN_ID: '42' },
      logger,
      now: NOW,
    });
    const data = JSON.parse(await readFile(path.join(reports, '2026-11', `${REPORT_KEY}-data.json`), 'utf8'));
    const html = await readFile(path.join(reports, '2026-11', `${REPORT_KEY}-report.html`), 'utf8');
    return { code, logger, data, html, dir, reports };
  }

  /** data.json without the hash of the tmp file. */
  const stable = data => ({ ...data, input: { ...data.input, sha256: '<sha>' } });

  it('writes data.json with summary, results and the merged history', async t => {
    const { code, logger, data, reports } = await runReport('full');
    assert.equal(code, 0);
    assert.deepEqual(Object.keys(data), [
      'report_id', 'run_at', 'org', 'ospo_sha', 'run_url', 'previous_report', 'input', 'scope', 'summary', 'history',
      'repositories', 'catalogue', 'results', 'skipped', 'errors',
    ]);
    assert.equal(data.run_url, 'https://github.com/allianz/ospo/actions/runs/42');
    assert.equal(data.ospo_sha, 'abc123');
    t.assert.snapshot(stable(data));
    t.assert.snapshot(logger.output().replaceAll(reports, '<reports>'));
  });

  it('writes the HTML report next to data.json, with exactly that data embedded', async () => {
    const { data, html, reports } = await runReport('html');
    const embedded = html.match(/<script type="application\/json" id="data.json">(.*?)<\/script>/s)[1];
    assert.deepEqual(JSON.parse(embedded), data);
    assert.ok(!html.includes(DATA_PLACEHOLDER));
    assert.match(html, /<title>OpenSSF Scorecard Report · test-org · 2026-11<\/title>/);
    assert.deepEqual(await readdir(path.join(reports, '2026-11')), ['scorecard-data.json', 'scorecard-report.html']);
  });

  it('starts the history without a previous report and lists the repositories with --debug', async () => {
    const { data, logger } = await runReport('first', { previous: false, argv: ['--debug'], debug: true });
    assert.equal(data.previous_report, null);
    assert.deepEqual(data.history.map(e => e.month), ['2026-11']);
    assert.match(logger.output(), /History: 1 month \(previous report: none\)/);
    assert.match(logger.output(), /Average score: 6\.4, median 6\.4\n/);
    assert.match(logger.output(), /\n {2}alpha 8\.5 \(1 failed\)\n {2}beta 4\.2 \(1 failed\)\n/);
  });

  it('writes a report with a data-health warning when scorecard.json is missing or invalid', async () => {
    const missing = await runReport('missing', { doc: null });
    assert.equal(missing.code, 0);
    assert.equal(missing.data.input.status, 'missing');
    assert.match(missing.logger.output(), /Input: scorecard\.json missing\n/);
    assert.match(missing.logger.output(), /Average score: – \(previous 5\.5\), median –\n/);
    assert.match(missing.logger.output(), /Warning: data health: scorecard\.json missing\n/);

    const invalid = await runReport('invalid', { doc: scorecardDoc({ tool: 'lint_repos' }) });
    assert.match(invalid.logger.output(), /Input: scorecard\.json invalid: tool is 'lint_repos', expected 'scorecard_check'\n/);
  });

  it('names an unknown Scorecard version', async () => {
    const { scorecard_version: _v, ...doc } = scorecardDoc();
    const { logger } = await runReport('no-version', { doc });
    assert.match(logger.output(), /Scorecard unknown\n/);
  });

  it('requires --dir', async () => {
    await assert.rejects(() => run({ argv: ['--org', org] }), err => err instanceof ScriptError && err.message === '--dir is required');
  });
});

// ── Template ─────────────────────────────────────────────────────────────────

describe('the Scorecard report template', () => {
  it('has both placeholders once, the render guard and no external resources', async () => {
    const template = await loadTemplate(TEMPLATE_PATH);
    assert.equal(template.split(DATA_PLACEHOLDER).length, 2);
    assert.equal(template.split(TITLE_PLACEHOLDER).length, 2);
    assert.doesNotMatch(template, /<(script|link|img)[^>]+(src|href)="https?:/i);
    assert.match(template, /id="render-error"/);
    assert.match(template, /dataset\.render = 'ok'/);
    assert.match(template, /^<!doctype html>/);
  });
});
