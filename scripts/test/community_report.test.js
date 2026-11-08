import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  INPUT, REPORT_KEY, TEMPLATE_PATH,
  addMonths, buildData, buildHighlights, computeGrowth, dataHealth, heldMilestones, historyEntry, periodBefore,
  previousEntry, readInput, reportTitle, run, validateCommunity,
} from '../community_report.js';
import { ScriptError } from '../lib/cli.js';
import { DATA_PLACEHOLDER, TITLE_PLACEHOLDER, loadTemplate } from '../lib/report_html.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-01T04:00:00Z');
const PERIOD = { month: '2026-10', from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'community-report-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ie = (internal, external) => ({ internal, external });
const traffic = (visitors, from = '2026-10-18', to = '2026-10-31') => ({ views: visitors * 4, visitors, clones: visitors, cloners: Math.round(visitors / 4), from, to });

function repoEntry(repo, extra = {}) {
  return {
    repo, description: `${repo} project`, created_at: '2024-05-01T10:00:00Z', pushed_at: '2026-10-20T16:00:00Z',
    stars: 50, forks: 5, new_project: false, active: true,
    contributors: ie(3, 1), new_contributors: ie(0, 0), active_contributors: ie(1, 0), commits: 12,
    prs: { opened: ie(2, 1), merged: ie(2, 1), closed_unmerged: ie(0, 0) },
    issues: { opened: ie(1, 2), closed: ie(1, 1) },
    releases: { period: 1, total: 4, tags: ['v1.1.0'] }, release_downloads: 30, traffic: traffic(100),
    ...extra,
  };
}

const TOTALS = {
  public_projects: 3, new_projects: 1, active_projects: 2, stars: 163, forks: 19,
  contributors: ie(8, 3), new_contributors: ie(2, 1), active_contributors: ie(4, 2), commits: 30,
  prs_merged: ie(4, 2), releases: 2, release_downloads: 60, traffic: { views: 800, visitors: 200, clones: 210, cloners: 50 },
};

/** community.json: alpha got its first external contributor, beta is new, gamma has no contributor statistics. */
function communityDoc(extra = {}) {
  return {
    tool: 'community_metrics', run_at: '2026-11-01T03:00:00Z', org, ospo_sha: 'abc123',
    config_file: 'config/community_metrics.yaml', config_sha256: 'f'.repeat(64), run_url: null, issue_title: null,
    results: [], catalogue: {},
    skipped: [{ repo: '.github', reason: 'excluded_repos' }],
    errors: [{ repo: 'gamma', metric: 'contributors', reason: 'Contributor statistics not ready after 10 attempts' }],
    period: PERIOD,
    levels: { milestones: { stars: [100, 150, 1000], contributors: [10, 20], visitors: [100] }, active_within: '90 days' },
    totals: TOTALS,
    repositories: [
      repoEntry('gamma', { contributors: null, new_contributors: null, active_contributors: null, commits: null, traffic: null }),
      repoEntry('alpha', { stars: 110 }),
      repoEntry('beta', { new_project: true, created_at: '2026-10-10T09:00:00Z', stars: 3, description: 'Starter kit' }),
    ],
    releases: [{ repo: 'alpha', tag: 'v1.1.0', date: '2026-10-02' }, { repo: 'beta', tag: 'v0.1.0', date: '2026-10-28' }],
    ...extra,
  };
}

/** A history entry of an earlier month with the given totals. */
function earlier(period, { stars, visitors = 150, contributors = ie(7, 2), milestones = [], repositories = {} }) {
  return {
    month: addMonths(period, 1), period,
    totals: { ...TOTALS, stars, contributors, traffic: { views: 600, visitors, clones: 150, cloners: 40 } },
    repositories, milestones,
  };
}

const PREVIOUS = {
  report_id: 'OSPO-CM-2026-10',
  history: [
    earlier('2026-04', { stars: 90, visitors: 100 }),
    earlier('2026-08', { stars: 120, milestones: ['stars-100', 'visitors-100'] }),
    earlier('2026-09', { stars: 140, milestones: ['stars-100', 'visitors-100'], repositories: { alpha: { contributors: ie(3, 0) }, gamma: { contributors: ie(2, 0) } } }),
  ],
};

const header = { run_at: '2026-11-01T04:00:00Z', org, ospo_sha: 'def456', run_url: null };
const okInput = { file: INPUT.file, script: INPUT.script, status: 'ok', sha256: 'x' };

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('months', () => {
  it('adds months across years', () => {
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.equal(addMonths('2026-10', 6), '2027-04');
  });

  it('derives the period of a run without input', () => {
    assert.deepEqual(periodBefore('2026-11'), PERIOD);
  });
});

// ── Input ────────────────────────────────────────────────────────────────────

describe('validateCommunity', () => {
  it('accepts the output of community_metrics', () => {
    assert.deepEqual(validateCommunity(communityDoc()), []);
  });

  it('names every problem', () => {
    assert.deepEqual(validateCommunity({ period: { month: 'Oct' }, levels: {}, totals: [], releases: {}, repositories: {} }), [
      'period must have month (YYYY-MM), from and to',
      'levels.milestones must be an object',
      'totals must be an object',
      'releases must be a list',
      'repositories must be a list',
    ]);
    assert.deepEqual(validateCommunity(communityDoc({ repositories: [{ repo: 'a' }, { repo: 'a' }, {}] })), [
      'repositories: a is listed twice',
      'every repositories entry needs repo',
    ]);
  });
});

describe('readInput', () => {
  it('reads an ok file with its header and counts', async () => {
    const dir = path.join(tmpDir, 'input-ok');
    await mkdir(dir);
    await writeFile(path.join(dir, INPUT.file), JSON.stringify(communityDoc()));
    const { input, doc } = await readInput(dir, org);
    assert.equal(input.status, 'ok');
    assert.equal(input.tool, 'community_metrics');
    assert.deepEqual(input.counts, { repositories: 3, skipped: 1, errors: 1 });
    assert.equal(doc.repositories.length, 3);
  });

  it('reports a missing or invalid file', async () => {
    const dir = path.join(tmpDir, 'input-bad');
    await mkdir(dir);
    assert.deepEqual((await readInput(dir, org)).input, { file: INPUT.file, script: INPUT.script, status: 'missing', sha256: null });
    await writeFile(path.join(dir, INPUT.file), JSON.stringify(communityDoc({ totals: null })));
    const { input, doc } = await readInput(dir, org);
    assert.equal(input.status, 'invalid');
    assert.deepEqual(input.problems, ['totals must be an object']);
    assert.equal(doc, null);
  });
});

// ── Compute ──────────────────────────────────────────────────────────────────

describe('historyEntry', () => {
  it('keeps the totals and the per-project numbers of the trends, without traffic dates', () => {
    const entry = historyEntry('2026-11', PERIOD, TOTALS, [repoEntry('alpha'), repoEntry('gamma', { traffic: null, prs: null, releases: null, contributors: null, commits: null, release_downloads: null })], ['stars-100']);
    assert.equal(entry.period, '2026-10');
    assert.deepEqual(entry.repositories.alpha, {
      traffic: { views: 400, visitors: 100, clones: 100, cloners: 25 }, stars: 50, forks: 5, contributors: ie(3, 1),
      prs_merged: ie(2, 1), commits: 12, releases_total: 4, release_downloads: 30,
    });
    assert.deepEqual(entry.repositories.gamma, { traffic: null, stars: 50, forks: 5, contributors: null, prs_merged: null, commits: null, releases_total: null, release_downloads: null });
    assert.deepEqual(entry.milestones, ['stars-100']);
  });
});

describe('computeGrowth', () => {
  it('compares with the month before and 6 months before, null without that month', () => {
    const history = [...PREVIOUS.history, historyEntry('2026-11', PERIOD, TOTALS, [], [])];
    const growth = computeGrowth(history, '2026-10');
    assert.deepEqual(growth.stars, { value: 163, previous: 140, six_months_ago: 90 });
    assert.deepEqual(growth.contributors, { value: 11, previous: 9, six_months_ago: 9 });
    assert.deepEqual(growth.external_contributors, { value: 3, previous: 2, six_months_ago: 2 });
    assert.deepEqual(computeGrowth(PREVIOUS.history, '2026-08').stars, { value: 120, previous: null, six_months_ago: null });
  });

  it('is null where the totals have no such number', () => {
    const history = [historyEntry('2026-11', PERIOD, { ...TOTALS, traffic: null }, [], [])];
    assert.deepEqual(computeGrowth(history, '2026-10').visitors, { value: null, previous: null, six_months_ago: null });
  });
});

describe('milestones', () => {
  it('holds every level the totals reach', () => {
    assert.deepEqual(heldMilestones({ stars: [100, 150, 1000], contributors: [10, 20], visitors: [100] }, TOTALS), ['stars-100', 'stars-150', 'contributors-10', 'visitors-100']);
    assert.deepEqual(heldMilestones({ visitors: [1] }, { ...TOTALS, traffic: null }), []);
  });

  it('compares with the latest earlier period', () => {
    assert.equal(previousEntry(PREVIOUS.history, '2026-10').period, '2026-09');
    assert.equal(previousEntry(PREVIOUS.history, '2026-04'), null);
  });
});

describe('buildHighlights', () => {
  const base = { newMilestones: [], repositories: [], totals: { ...TOTALS, new_contributors: ie(0, 0), releases: 0 }, before: null, periodMonth: '2026-10' };

  it('celebrates only the highest new level of a metric', () => {
    const highlights = buildHighlights({ ...base, newMilestones: ['stars-1000', 'stars-2500', 'public_projects-25'] });
    assert.deepEqual(highlights.map(h => h.text), ['The organisation passed 2,500 stars.', 'The organisation passed 25 public projects.']);
  });

  it('names new projects with or without a description', () => {
    const repositories = [repoEntry('a', { new_project: true, description: 'Starter kit.' }), repoEntry('b', { new_project: true, description: '' })];
    assert.deepEqual(buildHighlights({ ...base, repositories }).map(h => `${h.repo} ${h.text}`), ['a was published: Starter kit.', 'b was published.']);
  });

  it('welcomes first-time contributors', () => {
    const text = nc => buildHighlights({ ...base, totals: { ...base.totals, new_contributors: nc } })[0]?.text;
    assert.equal(text(ie(1, 0)), '1 person made their first contribution.');
    assert.equal(text(ie(0, 1)), '1 person from outside Allianz made their first contribution.');
    assert.equal(text(ie(3, 0)), '3 people made their first contribution.');
    assert.equal(text(ie(9, 2)), '11 people made their first contribution, 2 of them from outside Allianz.');
    assert.equal(text(null), undefined);
  });

  it('counts the releases of the month', () => {
    assert.equal(buildHighlights({ ...base, totals: { ...base.totals, releases: 1 } })[0].text, '1 release in October.');
  });
});

describe('buildData', () => {
  it('builds the report from the tool file and the previous report', () => {
    const data = buildData({ input: okInput, doc: communityDoc(), previous: { path: 'reports/2026-10/community-data.json', doc: PREVIOUS }, header });
    assert.equal(data.report_id, 'OSPO-CM-2026-11');
    assert.deepEqual(data.previous_report, { report_id: 'OSPO-CM-2026-10', data_url: 'https://github.com/allianz/ospo/blob/main/reports/2026-10/community-data.json' });
    assert.deepEqual(data.repositories.map(r => r.repo), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(data.milestones, ['stars-100', 'stars-150', 'contributors-10', 'visitors-100']);
    assert.deepEqual(data.new_milestones, ['stars-150', 'contributors-10']);
    assert.deepEqual(data.highlights.map(h => h.kind), ['milestone', 'milestone', 'new', 'first_external', 'welcome', 'releases']);
    assert.equal(data.highlights[3].repo, 'alpha');   // gamma had 0 external too, but has no statistics now
    assert.deepEqual(data.history.map(e => e.month), ['2026-05', '2026-09', '2026-10', '2026-11']);
    assert.deepEqual(data.growth.stars, { value: 163, previous: 140, six_months_ago: 90 });
    assert.equal(data.errors[0].metric, 'contributors');
  });

  it('starts without anything new in the first report', () => {
    const data = buildData({ input: okInput, doc: communityDoc(), previous: null, header });
    assert.equal(data.previous_report, null);
    assert.deepEqual(data.new_milestones, []);
    assert.deepEqual(data.history.map(e => e.month), ['2026-11']);
    assert.deepEqual(data.growth.stars, { value: 163, previous: null, six_months_ago: null });
  });

  it('gives an empty report without input and adds no history entry', () => {
    const input = { file: INPUT.file, script: INPUT.script, status: 'missing', sha256: null };
    const data = buildData({ input, doc: null, previous: { path: 'p', doc: PREVIOUS }, header });
    assert.deepEqual(data.period, PERIOD);
    assert.equal(data.totals.stars, null);
    assert.deepEqual(data.history, PREVIOUS.history);
    assert.deepEqual([data.milestones, data.highlights, data.repositories, data.releases, data.skipped, data.errors], [[], [], [], [], [], []]);
    assert.deepEqual(data.growth.stars, { value: null, previous: 140, six_months_ago: 90 });
    assert.deepEqual(dataHealth(data), ['data health: community.json missing']);
  });

  it('names the report', () => {
    assert.equal(reportTitle({ org, run_at: header.run_at }), 'Open Source Community Report · test-org · 2026-11');
  });
});

// ── run ──────────────────────────────────────────────────────────────────────

describe('run', () => {
  async function runReport(name, { doc = communityDoc(), previous = true, argv = [], debug = false } = {}) {
    const dir = path.join(tmpDir, name, 'results');
    const reports = path.join(tmpDir, name, 'reports');
    await mkdir(dir, { recursive: true });
    if (doc) await writeFile(path.join(dir, INPUT.file), JSON.stringify(doc));
    if (previous) {
      await mkdir(path.join(reports, '2026-10'), { recursive: true });
      await writeFile(path.join(reports, '2026-10', `${REPORT_KEY}-data.json`), JSON.stringify(PREVIOUS));
    }
    const logger = createMemoryLogger({ debug });
    const code = await run({ argv: ['--org', org, '--dir', dir, '--reports', reports, ...argv], logger, now: NOW, git: () => ({ revparse: async () => 'def456' }) });
    const month = path.join(reports, '2026-11');
    return {
      code, logger, reports,
      data: JSON.parse(await readFile(path.join(month, `${REPORT_KEY}-data.json`), 'utf8')),
      html: await readFile(path.join(month, `${REPORT_KEY}-report.html`), 'utf8'),
    };
  }

  it('writes community-data.json and logs the headline numbers', async t => {
    const { code, data, logger, reports } = await runReport('full');
    assert.equal(code, 0);
    assert.equal(data.input.status, 'ok');
    t.assert.snapshot(logger.output().replaceAll(reports, '<reports>'));
  });

  it('writes the HTML report next to data.json, with exactly that data embedded', async () => {
    const { data, html, reports } = await runReport('html');
    const embedded = html.match(/<script type="application\/json" id="data.json">(.*?)<\/script>/s)[1];
    assert.deepEqual(JSON.parse(embedded), data);
    assert.ok(!html.includes(DATA_PLACEHOLDER));
    assert.match(html, /<title>Open Source Community Report · test-org · 2026-11<\/title>/);
    assert.deepEqual(await readdir(path.join(reports, '2026-11')), ['community-data.json', 'community-report.html']);
  });

  it('lists the highlights with --debug', async () => {
    const { logger } = await runReport('debug', { previous: false, argv: ['--debug'], debug: true });
    assert.match(logger.output(), /History: 1 month \(previous report: none\)/);
    assert.match(logger.output(), /\n {2}🆕 beta was published: Starter kit\.\n/);
  });

  it('writes a report with a data-health warning when community.json is missing or invalid', async () => {
    const missing = await runReport('missing', { doc: null });
    assert.equal(missing.code, 0);
    assert.match(missing.logger.output(), /Input: community\.json missing\n/);
    assert.match(missing.logger.output(), /Stars: – \(previous 140\)/);
    assert.match(missing.logger.output(), /Warning: data health: community\.json missing\n/);

    const invalid = await runReport('invalid', { doc: communityDoc({ tool: 'lint_repos' }) });
    assert.match(invalid.logger.output(), /Input: community\.json invalid: tool is 'lint_repos', expected 'community_metrics'\n/);
  });

  it('requires --dir', async () => {
    await assert.rejects(() => run({ argv: ['--org', org] }), err => err instanceof ScriptError && err.message === '--dir is required');
  });
});

// ── Template ─────────────────────────────────────────────────────────────────

describe('the community report template', () => {
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
