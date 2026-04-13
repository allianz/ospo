import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig, parseRelativeDate, processRepos } from './archive_repos.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOctokit(overrides = {}) {
  return {
    paginate: overrides.paginate ?? (async () => []),
    rest: {
      issues: {
        listForRepo: Symbol('listForRepo'),
        create: overrides.issuesCreate ?? (async () => ({ data: {} })),
        update: overrides.issuesUpdate ?? (async () => ({ data: {} })),
      },
      repos: {
        update: overrides.reposUpdate ?? (async () => ({ data: {} })),
      },
    },
  };
}

function makeRepo(name, pushedAt) {
  return { name, pushed_at: pushedAt };
}

// ── parseRelativeDate ────────────────────────────────────────────────────────

describe('parseRelativeDate', () => {
  it('parses "2 years ago"', () => {
    const result = parseRelativeDate('2 years ago');
    const expected = new Date();
    expected.setUTCFullYear(expected.getUTCFullYear() - 2);
    assert.equal(result.getUTCFullYear(), expected.getUTCFullYear());
    assert.equal(result.getUTCMonth(), expected.getUTCMonth());
  });

  it('parses "40 days ago"', () => {
    const result = parseRelativeDate('40 days ago');
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 40);
    // Allow 1 second tolerance for test execution time
    assert.ok(Math.abs(result.getTime() - expected.getTime()) < 1000);
  });

  it('parses "6 months ago"', () => {
    const result = parseRelativeDate('6 months ago');
    const expected = new Date();
    expected.setUTCMonth(expected.getUTCMonth() - 6);
    assert.equal(result.getUTCFullYear(), expected.getUTCFullYear());
    assert.equal(result.getUTCMonth(), expected.getUTCMonth());
  });

  it('parses singular "1 year ago"', () => {
    const result = parseRelativeDate('1 year ago');
    const expected = new Date();
    expected.setUTCFullYear(expected.getUTCFullYear() - 1);
    assert.equal(result.getUTCFullYear(), expected.getUTCFullYear());
  });

  it('parses singular "1 day ago"', () => {
    const result = parseRelativeDate('1 day ago');
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 1);
    assert.ok(Math.abs(result.getTime() - expected.getTime()) < 1000);
  });

  it('parses "2 minutes ago"', () => {
    const result = parseRelativeDate('2 minutes ago');
    const expected = new Date();
    expected.setUTCMinutes(expected.getUTCMinutes() - 2);
    assert.ok(Math.abs(result.getTime() - expected.getTime()) < 1000);
  });

  it('parses singular "1 minute ago"', () => {
    const result = parseRelativeDate('1 minute ago');
    const expected = new Date();
    expected.setUTCMinutes(expected.getUTCMinutes() - 1);
    assert.ok(Math.abs(result.getTime() - expected.getTime()) < 1000);
  });

  it('parses singular "1 month ago"', () => {
    const result = parseRelativeDate('1 month ago');
    const expected = new Date();
    expected.setUTCMonth(expected.getUTCMonth() - 1);
    assert.equal(result.getUTCMonth(), expected.getUTCMonth());
  });

  it('throws on invalid format', () => {
    assert.throws(() => parseRelativeDate('last tuesday'), /Invalid relative date/);
  });

  it('parses without "ago" suffix', () => {
    const result = parseRelativeDate('2 years');
    const expected = new Date();
    expected.setUTCFullYear(expected.getUTCFullYear() - 2);
    assert.equal(result.getUTCFullYear(), expected.getUTCFullYear());
  });

  it('throws on non-numeric count', () => {
    assert.throws(() => parseRelativeDate('many days ago'), /Invalid relative date/);
  });
});

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir;
  before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'archive-test-')); });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('parses a valid config', async () => {
    const file = path.join(tmpDir, 'valid.yaml');
    await writeFile(file, [
      'excluded_repos:',
      '  - .github',
      '  - ospo',
      'warn_after: "2 years"',
      'grace_period: "40 days"',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.warn_after, '2 years');
    assert.equal(cfg.grace_period, '40 days');
    assert.deepEqual(cfg.excluded_repos, ['.github', 'ospo']);
  });

  it('defaults excluded_repos to empty array', async () => {
    const file = path.join(tmpDir, 'no-excluded.yaml');
    await writeFile(file, 'warn_after: "1 year"\ngrace_period: "30 days"\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.excluded_repos, []);
  });

  it('throws when warn_after is missing', async () => {
    const file = path.join(tmpDir, 'no-warn.yaml');
    await writeFile(file, 'grace_period: "40 days"\n');
    await assert.rejects(() => loadConfig(file), /warn_after/);
  });

  it('throws when grace_period is missing', async () => {
    const file = path.join(tmpDir, 'no-grace.yaml');
    await writeFile(file, 'warn_after: "2 years"\n');
    await assert.rejects(() => loadConfig(file), /grace_period/);
  });

  it('throws when warn_after has invalid format', async () => {
    const file = path.join(tmpDir, 'bad-warn.yaml');
    await writeFile(file, 'warn_after: "last week"\ngrace_period: "40 days"\n');
    await assert.rejects(() => loadConfig(file), /Invalid relative date/);
  });

  it('throws when grace_period has invalid format', async () => {
    const file = path.join(tmpDir, 'bad-grace.yaml');
    await writeFile(file, 'warn_after: "2 years"\ngrace_period: "soon"\n');
    await assert.rejects(() => loadConfig(file), /Invalid relative date/);
  });
});

// ── processRepos ─────────────────────────────────────────────────────────────

describe('processRepos', () => {
  const org = 'test-org';
  // staleCutoff: anything pushed before 2024-01-01 is stale
  const staleCutoff = new Date('2024-01-01T00:00:00Z');
  // graceCutoff: issues created before 2026-03-01 have expired grace period
  const graceCutoff = new Date('2026-03-01T00:00:00Z');
  const config = { staleCutoff, graceCutoff };

  it('creates a warning issue for stale repo with no existing issue', async () => {
    let createCalled = false;
    let archiveCalled = false;
    const octokit = makeOctokit({
      paginate: async () => [],  // no open issues
      issuesCreate: async () => { createCalled = true; return { data: {} }; },
      reposUpdate: async () => { archiveCalled = true; return { data: {} }; },
    });
    const repos = [makeRepo('old-repo', '2023-06-01T00:00:00Z')];

    await processRepos(octokit, org, repos, config);

    assert.ok(createCalled, 'should have created warning issue');
    assert.ok(!archiveCalled, 'should NOT archive (grace period just started)');
  });

  it('does not create or archive when stale repo has issue with unexpired grace period', async () => {
    let createCalled = false;
    let archiveCalled = false;
    const octokit = makeOctokit({
      paginate: async () => [
        { title: 'Inactive Repository Reminder', number: 12, created_at: '2026-03-15T00:00:00Z' },
      ],
      issuesCreate: async () => { createCalled = true; return { data: {} }; },
      reposUpdate: async () => { archiveCalled = true; return { data: {} }; },
    });
    const repos = [makeRepo('stale-repo', '2023-06-01T00:00:00Z')];

    await processRepos(octokit, org, repos, config);

    assert.ok(!createCalled, 'should NOT create issue (already exists)');
    assert.ok(!archiveCalled, 'should NOT archive (grace period not expired)');
  });

  it('archives stale repo when grace period has expired', async () => {
    let archiveCalled = false;
    let archivedRepo = null;
    const octokit = makeOctokit({
      paginate: async () => [
        { title: 'Inactive Repository Reminder', number: 8, created_at: '2026-01-15T00:00:00Z' },
      ],
      reposUpdate: async (params) => { archiveCalled = true; archivedRepo = params; return { data: {} }; },
    });
    const repos = [makeRepo('dead-repo', '2022-01-01T00:00:00Z')];

    await processRepos(octokit, org, repos, config);

    assert.ok(archiveCalled, 'should archive the repo');
    assert.equal(archivedRepo.repo, 'dead-repo');
    assert.equal(archivedRepo.archived, true);
  });

  it('closes warning issue when repo becomes active', async () => {
    let closeCalled = false;
    let closedParams = null;
    const octokit = makeOctokit({
      paginate: async () => [
        { title: 'Inactive Repository Reminder', number: 15, created_at: '2026-02-01T00:00:00Z' },
      ],
      issuesUpdate: async (params) => { closeCalled = true; closedParams = params; return { data: {} }; },
    });
    const repos = [makeRepo('active-repo', '2026-03-01T00:00:00Z')];

    await processRepos(octokit, org, repos, config);

    assert.ok(closeCalled, 'should close the warning issue');
    assert.equal(closedParams.issue_number, 15);
    assert.equal(closedParams.state, 'closed');
  });

  it('does nothing for active repo without warning issue', async () => {
    let createCalled = false;
    let updateCalled = false;
    let archiveCalled = false;
    const octokit = makeOctokit({
      paginate: async () => [],
      issuesCreate: async () => { createCalled = true; return { data: {} }; },
      issuesUpdate: async () => { updateCalled = true; return { data: {} }; },
      reposUpdate: async () => { archiveCalled = true; return { data: {} }; },
    });
    const repos = [makeRepo('healthy-repo', '2026-04-01T00:00:00Z')];

    await processRepos(octokit, org, repos, config);

    assert.ok(!createCalled, 'should NOT create issue');
    assert.ok(!updateCalled, 'should NOT close any issue');
    assert.ok(!archiveCalled, 'should NOT archive');
  });

  it('dry-run does not make any mutations', async () => {
    let createCalled = false;
    let updateCalled = false;
    let archiveCalled = false;
    const octokit = makeOctokit({
      paginate: async () => [
        { title: 'Inactive Repository Reminder', number: 8, created_at: '2026-01-15T00:00:00Z' },
      ],
      issuesCreate: async () => { createCalled = true; return { data: {} }; },
      issuesUpdate: async () => { updateCalled = true; return { data: {} }; },
      reposUpdate: async () => { archiveCalled = true; return { data: {} }; },
    });

    // Mix of scenarios: stale repo with expired grace, active repo with issue
    const repos = [
      makeRepo('dead-repo', '2022-01-01T00:00:00Z'),
      makeRepo('active-repo', '2026-03-01T00:00:00Z'),
    ];

    const { planned } = await processRepos(octokit, org, repos, config, { dryRun: true });

    assert.ok(!createCalled, 'should NOT call issues.create in dry-run');
    assert.ok(!updateCalled, 'should NOT call issues.update in dry-run');
    assert.ok(!archiveCalled, 'should NOT call repos.update in dry-run');
    assert.ok(planned.length > 0, 'should have planned changes');
  });

  it('dry-run does not plan archive for newly "created" issue', async () => {
    const octokit = makeOctokit({
      paginate: async () => [],  // no existing issue
    });
    const repos = [makeRepo('stale-repo', '2023-06-01T00:00:00Z')];

    const { planned } = await processRepos(octokit, org, repos, config, { dryRun: true });

    const hasCreate = planned.some(m => m.includes('create an issue'));
    const hasArchive = planned.some(m => m.includes('archive'));
    assert.ok(hasCreate, 'should plan issue creation');
    assert.ok(!hasArchive, 'should NOT plan archive (grace period just started)');
  });
});
