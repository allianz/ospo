import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULTS, TOOL,
  collectRepo, computeTotals, contributorActivity, countSides, createPeople, describePeriod, fetchContributorStats,
  issueActivity, loadConfig, periodOf, releaseMetrics, run, scopeRepos, trafficMetrics,
} from '../community_metrics.js';
import { ScriptError } from '../lib/cli.js';
import { createFakeGitHub } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-01T03:00:00Z');
const PERIOD = { month: '2026-10', from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };
const POLLING = { delayMs: 5, maxAttempts: 3 };

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'community-metrics-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

async function writeConfig(name, lines) {
  const file = path.join(tmpDir, name);
  await writeFile(file, lines.join('\n'));
  return file;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const user = (login, type = 'User') => ({ login, type });
/** A week of /stats/contributors starting on the given Sunday. */
const week = (sunday, c) => ({ w: Date.parse(`${sunday}T00:00:00Z`) / 1000, a: c, d: 0, c });
const author = (login, weeks, type = 'User') => ({ author: login ? user(login, type) : null, total: weeks.reduce((s, w) => s + w.c, 0), weeks });

const MEMBERS = ['Ana', 'dave', 'svc-deploy'];
const people = createPeople(MEMBERS, ['svc-deploy']);

const repo = (name, extra = {}) => ({
  name, visibility: 'public', archived: false, fork: false, description: `${name} project`,
  created_at: '2024-05-01T10:00:00Z', pushed_at: '2026-10-20T16:00:00Z', stargazers_count: 10, forks_count: 2, ...extra,
});

const REPOS = [
  repo('alpha', { stargazers_count: 120, forks_count: 14 }),
  repo('beta', { created_at: '2026-10-10T09:00:00Z', stargazers_count: 3, forks_count: 0, description: null }),
  repo('gamma', { pushed_at: '2026-06-01T00:00:00Z', stargazers_count: 40, forks_count: 5 }),
  repo('.github'),
  repo('secret', { visibility: 'private' }),
  repo('old', { archived: true }),
  repo('upstream-copy', { fork: true }),
];

const STATS = {
  alpha: [
    author('ana', [week('2025-03-02', 4), week('2026-10-04', 3), week('2026-10-25', 2)]),
    author('bob', [week('2026-09-27', 1), week('2026-10-11', 5)]),   // the week of 27 Sep counts in September
    author('dave', [week('2025-03-02', 2)]),
    author('dependabot[bot]', [week('2026-10-04', 7)], 'Bot'),
    author('svc-deploy', [week('2026-10-04', 9)]),
    author(null, [week('2026-10-04', 1)]),
  ],
  beta: [
    author('dave', [week('2026-10-11', 6)]),   // new in beta, not new in the organisation
    author('erin', [week('2026-10-18', 1)]),
  ],
};

const ISSUES = {
  alpha: [
    { number: 1, user: user('carl'), created_at: '2026-10-03T10:00:00Z', closed_at: null, updated_at: '2026-10-03T10:00:00Z' },
    { number: 2, user: user('ana'), created_at: '2026-08-01T10:00:00Z', closed_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z' },
    { number: 3, user: user('renovate[bot]', 'Bot'), created_at: '2026-10-05T10:00:00Z', closed_at: null, updated_at: '2026-10-05T10:00:00Z' },
    { number: 4, user: user('bob'), pull_request: {}, created_at: '2026-10-06T10:00:00Z', updated_at: '2026-10-06T10:00:00Z' },
    { number: 5, user: user('carl'), created_at: '2026-05-01T10:00:00Z', closed_at: '2026-05-02T10:00:00Z', updated_at: '2026-05-02T10:00:00Z' },
  ],
};

const PULLS = {
  alpha: [
    { number: 4, user: user('bob'), created_at: '2026-10-06T10:00:00Z', merged_at: '2026-10-08T10:00:00Z', closed_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-08T10:00:00Z' },
    { number: 6, user: user('ana'), created_at: '2026-10-07T10:00:00Z', merged_at: null, closed_at: '2026-10-09T10:00:00Z', updated_at: '2026-10-09T10:00:00Z' },
    { number: 7, user: user('ana'), created_at: '2026-09-20T10:00:00Z', merged_at: '2026-10-02T10:00:00Z', closed_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z' },
    { number: 8, user: user('frank'), created_at: '2026-10-30T10:00:00Z', merged_at: null, closed_at: null, updated_at: '2026-11-01T01:00:00Z' },
    { number: 9, user: user('dependabot[bot]', 'Bot'), created_at: '2026-10-10T10:00:00Z', merged_at: '2026-10-10T11:00:00Z', closed_at: '2026-10-10T11:00:00Z', updated_at: '2026-10-10T11:00:00Z' },
  ],
};

const asset = n => ({ name: 'a.zip', download_count: n });
const RELEASES = {
  alpha: [
    { tag_name: 'v1.0.0', draft: false, published_at: '2025-01-10T10:00:00Z', assets: [asset(50), asset(5)] },
    { tag_name: 'v1.2.0', draft: false, published_at: '2026-10-20T10:00:00Z', assets: [asset(3)] },
    { tag_name: 'v1.1.0', draft: false, published_at: '2026-10-02T10:00:00Z', assets: [] },
    { tag_name: 'v2.0.0', draft: true, published_at: null, assets: [asset(1)] },
  ],
  beta: [{ tag_name: 'v0.1.0', draft: false, published_at: '2026-10-28T10:00:00Z' }],
};

const days = (from, values) => values.map((count, i) => ({ timestamp: `2026-10-${String(from + i).padStart(2, '0')}T00:00:00Z`, count, uniques: 1 }));
const TRAFFIC = {
  alpha: { views: { count: 300, uniques: 80, views: days(18, [100, 200]) }, clones: { count: 40, uniques: 12, clones: days(19, [40]) } },
  beta: { views: { count: 20, uniques: 7, views: days(28, [20]) }, clones: { count: 0, uniques: 0, clones: [] } },
};

const forbidden = () => Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
const gone = () => Object.assign(new Error('Issues are disabled for this repo'), { status: 410 });

function scenario(extra = {}) {
  return createFakeGitHub({
    repos: REPOS,
    members: MEMBERS,
    contributorStats: STATS,
    pendingStats: { beta: 2, gamma: 99 },
    issues: ISSUES,
    pulls: PULLS,
    releases: RELEASES,
    traffic: TRAFFIC,
    failures: {
      getTrafficViews: (o, r) => r === 'gamma' && forbidden(),
      listIssuesSince: (o, r) => r === 'gamma' && gone(),
    },
    ...extra,
  });
}

// ── Config ───────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('fills in the defaults, also for an empty file', async () => {
    const config = await loadConfig(await writeConfig('empty.yaml', ['# only a comment']));
    assert.deepEqual(config, DEFAULTS);
  });

  it('keeps configured values and the default levels of metrics left out', async () => {
    const config = await loadConfig(await writeConfig('set.yaml', ['excluded_repos: [x]', 'bots: [svc]', 'active_within: "30 days"', 'milestones:', '  stars: [5, 50]']));
    assert.deepEqual(config.excluded_repos, ['x']);
    assert.deepEqual(config.bots, ['svc']);
    assert.equal(config.active_within, '30 days');
    assert.deepEqual(config.milestones.stars, [5, 50]);
    assert.deepEqual(config.milestones.visitors, DEFAULTS.milestones.visitors);
  });

  const invalid = [
    [['bots: svc'], /bots must be a list of strings/],
    [['excluded_repos: [1]'], /excluded_repos must be a list of strings/],
    [['active_within: soon'], /active_within: Invalid relative date/],
    [['milestones: [1, 2]'], /milestones must be a map/],
    [['milestones:', '  forks: [1]'], /milestones\.forks is not a metric/],
    [['milestones:', '  stars: [10, 5]'], /milestones\.stars must be positive integers in increasing order/],
    [['milestones:', '  stars: [0]'], /milestones\.stars must be positive integers/],
    [['milestones:', '  stars: 10'], /milestones\.stars must be positive integers/],
  ];
  for (const [i, [lines, message]] of invalid.entries()) {
    it(`rejects ${lines.join(' ')}`, async () => {
      const file = await writeConfig(`bad-${i}.yaml`, lines);
      await assert.rejects(() => loadConfig(file), message);
    });
  }
});

// ── Period and scope ─────────────────────────────────────────────────────────

describe('periodOf', () => {
  it('is the calendar month before the run', () => {
    assert.deepEqual(periodOf(NOW), PERIOD);
    assert.deepEqual(periodOf(new Date('2027-01-15T12:00:00Z')), { month: '2026-12', from: '2026-12-01T00:00:00Z', to: '2027-01-01T00:00:00Z' });
  });

  it('describes the period with its last day', () => {
    assert.equal(describePeriod(PERIOD), 'October 2026 (2026-10-01 – 2026-10-31)');
  });
});

describe('scopeRepos', () => {
  it('keeps public repositories that are no fork and not archived, sorted', () => {
    const { inScope, skipped } = scopeRepos(REPOS, ['.github', 'old']);
    assert.deepEqual(inScope.map(r => r.name), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(skipped, [
      { repo: '.github', reason: 'excluded_repos' },
      { repo: 'old', reason: 'excluded_repos' },
      { repo: 'secret', reason: 'private' },
      { repo: 'upstream-copy', reason: 'fork' },
    ]);
  });

  it('treats a repository with private: true as private', () => {
    assert.deepEqual(scopeRepos([{ name: 'p', private: true }], []).skipped, [{ repo: 'p', reason: 'private' }]);
  });
});

// ── People and metrics ───────────────────────────────────────────────────────

describe('createPeople', () => {
  it('leaves out bots and missing accounts, and tells members from everybody else', () => {
    assert.equal(people.login(user('Ana')), 'ana');
    assert.equal(people.login(user('x', 'Bot')), null);
    assert.equal(people.login(user('helper[bot]')), null);
    assert.equal(people.login(user('SVC-deploy')), null);
    assert.equal(people.login(null), null);
    assert.equal(people.side('ana'), 'internal');
    assert.equal(people.side('bob'), 'external');
    assert.deepEqual(countSides(['ana', 'bob', 'carl'], people), { internal: 1, external: 2 });
  });
});

describe('contributorActivity', () => {
  it('finds the first week of every author and the commits of the weeks starting in the period', () => {
    const { authors, active, commits } = contributorActivity(STATS.alpha, PERIOD, people);
    assert.deepEqual([...authors], [['ana', '2025-03-02T00:00:00Z'], ['bob', '2026-09-27T00:00:00Z'], ['dave', '2025-03-02T00:00:00Z']]);
    assert.deepEqual([...active], ['ana', 'bob']);
    assert.equal(commits, 10);
  });

  it('ignores weeks without commits and entries without weeks', () => {
    const { authors } = contributorActivity([author('x', [week('2026-10-04', 0)]), { author: user('y') }], PERIOD, people);
    assert.equal(authors.size, 0);
  });
});

describe('issueActivity', () => {
  it('counts issues and pull requests of the period by author, without bots', () => {
    const activity = issueActivity(ISSUES.alpha, PULLS.alpha, PERIOD, people);
    assert.deepEqual(activity.issues, { opened: { internal: 0, external: 1 }, closed: { internal: 1, external: 0 } });
    assert.deepEqual(activity.prs, {
      opened: { internal: 1, external: 2 },
      merged: { internal: 1, external: 1 },
      closed_unmerged: { internal: 1, external: 0 },
    });
    assert.deepEqual([...activity.openers].sort(), ['ana', 'bob', 'carl', 'frank']);
  });
});

describe('trafficMetrics', () => {
  it('sums views and clones and takes the window from the days returned', () => {
    assert.deepEqual(trafficMetrics(TRAFFIC.alpha.views, TRAFFIC.alpha.clones), { views: 300, visitors: 80, clones: 40, cloners: 12, from: '2026-10-18', to: '2026-10-19' });
  });

  it('has no window without days', () => {
    assert.deepEqual(trafficMetrics({}, {}), { views: 0, visitors: 0, clones: 0, cloners: 0, from: null, to: null });
  });
});

describe('releaseMetrics', () => {
  it('counts published releases of the period (oldest first) and all-time, and their downloads', () => {
    assert.deepEqual(releaseMetrics(RELEASES.alpha, PERIOD), {
      releases: { period: 2, total: 3, tags: ['v1.1.0', 'v1.2.0'] },
      release_downloads: 58,
      list: [{ tag: 'v1.1.0', date: '2026-10-02' }, { tag: 'v1.2.0', date: '2026-10-20' }],
    });
  });
});

// ── GitHub reads ─────────────────────────────────────────────────────────────

describe('fetchContributorStats', () => {
  it('asks again while GitHub computes the statistics', async () => {
    const gh = scenario();
    const waits = [];
    const result = await fetchContributorStats(gh, org, 'beta', { sleep: async ms => waits.push(ms), polling: POLLING });
    assert.equal(result.stats.length, 2);
    assert.deepEqual(waits, [5, 5]);
  });

  it('gives up after the last attempt', async () => {
    const gh = scenario();
    const waits = [];
    const result = await fetchContributorStats(gh, org, 'gamma', { sleep: async ms => waits.push(ms), polling: POLLING });
    assert.match(result.error, /not ready after 3 attempts/);
    assert.equal(waits.length, 2);
    assert.equal(gh.callsTo('getContributorStats').length, 3);
  });

  it('gives no contributors for an empty repository (204)', async () => {
    assert.deepEqual(await fetchContributorStats(scenario(), org, 'unknown', { polling: POLLING }), { stats: [] });
  });
});

describe('collectRepo', () => {
  const options = { period: PERIOD, activeSince: '2026-08-02T00:00:00Z', people, sleep: async () => {}, polling: POLLING };

  it('writes counts only and keeps the logins in memory', async () => {
    const { entry, authors, active, releases, errors } = await collectRepo(scenario(), org, REPOS[0], options);
    assert.deepEqual(entry.contributors, { internal: 2, external: 1 });
    assert.deepEqual(entry.new_contributors, { internal: 0, external: 0 });
    assert.deepEqual(entry.active_contributors, { internal: 1, external: 3 });
    assert.equal(entry.commits, 10);
    assert.equal(entry.active, true);
    assert.equal(entry.new_project, false);
    assert.deepEqual([...authors.keys()], ['ana', 'bob', 'dave']);
    assert.deepEqual([...active].sort(), ['ana', 'bob', 'carl', 'frank']);
    assert.deepEqual(releases.map(r => `${r.repo} ${r.tag}`), ['alpha v1.1.0', 'alpha v1.2.0']);
    assert.deepEqual(errors, []);
    assert.doesNotMatch(JSON.stringify(entry), /ana|bob|carl|dave|frank/);
  });

  it('leaves a metric that cannot be read null and names it in errors', async () => {
    const gh = scenario({
      failures: {
        listPullsUpdatedSince: forbidden,
        listReleases: forbidden,
        getTrafficClones: forbidden,
        listIssuesSince: forbidden,
        getContributorStats: forbidden,
      },
    });
    const { entry, errors } = await collectRepo(gh, org, REPOS[0], options);
    for (const key of ['contributors', 'new_contributors', 'active_contributors', 'commits', 'prs', 'issues', 'releases', 'release_downloads', 'traffic']) {
      assert.equal(entry[key], null, key);
    }
    assert.deepEqual(errors.map(e => e.metric), ['contributors', 'issues', 'prs', 'releases', 'traffic']);
    assert.match(errors[0].reason, /Contributor statistics not readable \(request returned 403: missing permission\)/);
  });

  it('counts no issues where issues are disabled (410) and is not active without a recent push', async () => {
    const { entry, errors } = await collectRepo(scenario(), org, REPOS[2], options);
    assert.deepEqual(entry.issues, { opened: { internal: 0, external: 0 }, closed: { internal: 0, external: 0 } });
    assert.equal(entry.active, false);
    assert.deepEqual(errors.map(e => e.metric), ['contributors', 'traffic']);
  });

  it('throws other errors', async () => {
    const gh = scenario({ failures: { listReleases: () => Object.assign(new Error('boom'), { status: 500 }) } });
    await assert.rejects(() => collectRepo(gh, org, REPOS[0], options), /boom/);
  });
});

describe('computeTotals', () => {
  it('counts people once across repositories; new means new in the organisation', async () => {
    const gh = scenario();
    const options = { period: PERIOD, activeSince: '2026-08-02T00:00:00Z', people, sleep: async () => {}, polling: POLLING };
    const collected = [];
    for (const r of REPOS.slice(0, 3)) collected.push(await collectRepo(gh, org, r, options));
    const totals = computeTotals(collected, PERIOD, people);
    assert.deepEqual(totals.contributors, { internal: 2, external: 2 });     // ana, dave; bob, erin
    assert.deepEqual(totals.new_contributors, { internal: 0, external: 1 }); // erin (dave contributed to alpha in 2025)
    assert.deepEqual(totals.active_contributors, { internal: 2, external: 4 });
    assert.deepEqual(totals.traffic, { views: 320, visitors: 87, clones: 40, cloners: 12 });
    assert.equal(totals.stars, 163);
    assert.equal(totals.releases, 3);
    assert.equal(totals.new_projects, 1);
    assert.equal(totals.active_projects, 2);
  });

  it('has no traffic when no repository has any', () => {
    const totals = computeTotals([], PERIOD, people);
    assert.equal(totals.traffic, null);
    assert.equal(totals.public_projects, 0);
  });
});

// ── run ──────────────────────────────────────────────────────────────────────

describe('run', () => {
  async function runMetrics(name, { argv = [], gh = scenario(), debug = false } = {}) {
    const config = path.join(tmpDir, `${name}.yaml`);
    await writeFile(config, 'excluded_repos: [".github"]\nbots: [svc-deploy]\n');
    const json = path.join(tmpDir, `${name}.json`);
    const logger = createMemoryLogger({ debug });
    const waits = [];
    const code = await run({
      argv: ['--org', org, '--config', config, '--json', json, ...argv],
      github: gh, logger, now: NOW, git: () => ({ revparse: async () => 'abc123' }),
      sleep: async ms => waits.push(ms), polling: POLLING,
    });
    return { code, gh, logger, waits, doc: JSON.parse(await readFile(json, 'utf8')), json };
  }

  it('writes the metrics of the previous month without logins and never writes to GitHub', async t => {
    const { code, gh, logger, doc, json } = await runMetrics('full');
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    assert.equal(doc.tool, TOOL);
    assert.deepEqual(doc.results, []);
    assert.deepEqual(doc.catalogue, {});
    assert.doesNotMatch(JSON.stringify(doc), /"(ana|bob|carl|dave|erin|frank)"/);
    t.assert.snapshot(logger.output().replace(json, '<json>'));
    t.assert.snapshot({ ...doc, config_file: '<config>', config_sha256: '<sha>' });
  });

  it('lists every repository with --debug', async () => {
    const { logger } = await runMetrics('debug', { argv: ['--debug'], debug: true });
    assert.match(logger.output(), /\n {2}alpha: 120 stars, 3 contributors \(1 external\), 10 commits, 2 PRs merged, 2 releases, 80 visitors\n/);
    assert.match(logger.output(), /\n {2}gamma: 40 stars, contributors –, – commits, 0 PRs merged, 0 releases, – visitors\n/);
  });

  it('requires --json', async () => {
    await assert.rejects(() => run({ argv: ['--org', org], github: scenario() }), err => err instanceof ScriptError && err.message === '--json is required');
  });
});
