import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  checkDescription,
  checkTopics,
  checkLicense,
  checkRequiredFile,
  buildIssueBody,
  cloneOrUpdate,
  formatResultLine,
  metadataChecks,
  requiredFileCheckId,
  runChecks,
  buildCatalogue,
  buildJsonResults,
  run,
} from '../lint_repos.js';
import { createFakeGitHub } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir;
  before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'lint-test-')); });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('parses a valid config', async () => {
    const file = path.join(tmpDir, 'valid.yaml');
    await writeFile(file, [
      'issue_title: "My Title"',
      'docs_link: "https://example.com"',
      'allowed_topics: [api, cli]',
      'excluded_repos: [".github"]',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.issue_title, 'My Title');
    assert.deepEqual(cfg.allowed_topics, ['api', 'cli']);
    assert.deepEqual(cfg.excluded_repos, ['.github']);
  });

  it('throws when issue_title is missing', async () => {
    const file = path.join(tmpDir, 'no-title.yaml');
    await writeFile(file, 'docs_link: "https://example.com"\n');
    await assert.rejects(() => loadConfig(file), /issue_title/);
  });

  it('defaults allowed_topics to [] when absent', async () => {
    const file = path.join(tmpDir, 'no-topics.yaml');
    await writeFile(file, 'issue_title: "T"\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.allowed_topics, []);
  });

  it('defaults excluded_repos to [] when absent', async () => {
    const file = path.join(tmpDir, 'no-excluded.yaml');
    await writeFile(file, 'issue_title: "T"\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.excluded_repos, []);
  });

  it('preserves excluded_repos list', async () => {
    const file = path.join(tmpDir, 'excluded.yaml');
    await writeFile(file, 'issue_title: "T"\nexcluded_repos: [".github", "ng-aquila"]\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.excluded_repos, ['.github', 'ng-aquila']);
  });

  it('defaults description_length to { min: 30, max: 150 } when absent', async () => {
    const file = path.join(tmpDir, 'no-desc-length.yaml');
    await writeFile(file, 'issue_title: "T"\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.description_length, { min: 30, max: 150 });
  });
});

// ── checkDescription ──────────────────────────────────────────────────────────

describe('checkDescription', () => {
  const len = { min: 30, max: 150 };
  const exactly30 = 'A'.repeat(30);
  const exactly150 = 'A'.repeat(150);

  it('passes when description is within bounds', () => {
    assert.equal(checkDescription({ description: 'Sample repo for testing compliance lint checks ok.' }, len).passed, true);
  });

  it('passes when description is exactly min length', () => {
    assert.equal(checkDescription({ description: exactly30 }, len).passed, true);
  });

  it('passes when description is exactly max length', () => {
    assert.equal(checkDescription({ description: exactly150 }, len).passed, true);
  });

  it('fails when description is empty string', () => {
    const r = checkDescription({ description: '' }, len);
    assert.equal(r.passed, false);
    assert.ok(r.detail);
  });

  it('fails when description is null', () => {
    assert.equal(checkDescription({ description: null }, len).passed, false);
  });

  it('fails when description is undefined', () => {
    assert.equal(checkDescription({}, len).passed, false);
  });

  it('fails when description is whitespace only', () => {
    assert.equal(checkDescription({ description: '   ' }, len).passed, false);
  });

  it('fails when description is one char below min', () => {
    const r = checkDescription({ description: 'A'.repeat(29) }, len);
    assert.equal(r.passed, false);
    assert.match(r.detail, /too short/);
    assert.match(r.detail, /minimum is 30/);
  });

  it('fails when description is one char above max', () => {
    const r = checkDescription({ description: 'A'.repeat(151) }, len);
    assert.equal(r.passed, false);
    assert.match(r.detail, /too long/);
    assert.match(r.detail, /maximum is 150/);
  });
});

// ── checkTopics ───────────────────────────────────────────────────────────────

describe('checkTopics', () => {
  const allowed = ['api', 'cli', 'docs', 'library', 'service'];

  it('passes with one valid topic', () => {
    assert.equal(checkTopics({ topics: ['api'] }, allowed).passed, true);
  });

  it('passes with two valid topics', () => {
    assert.equal(checkTopics({ topics: ['api', 'cli'] }, allowed).passed, true);
  });

  it('fails when no topics assigned', () => {
    const r = checkTopics({ topics: [] }, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /No topics/);
  });

  it('fails when topics is absent', () => {
    const r = checkTopics({}, allowed);
    assert.equal(r.passed, false);
  });

  it('fails with more than 5 topics', () => {
    const r = checkTopics({ topics: ['api', 'cli', 'docs', 'library', 'service', 'web'] }, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /Too many/);
  });

  it('fails when topic not in allowed list', () => {
    const r = checkTopics({ topics: ['notallowed'] }, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /notallowed/);
  });

  it('passes any topic when allowedTopics is empty', () => {
    assert.equal(checkTopics({ topics: ['anything'] }, []).passed, true);
  });

  it('passes exactly 5 topics', () => {
    assert.equal(checkTopics({ topics: ['api', 'cli', 'docs', 'library', 'service'] }, allowed).passed, true);
  });
});

// ── checkLicense ──────────────────────────────────────────────────────────────

describe('checkLicense', () => {
  const allowed = ['Apache-2.0', 'MIT', 'CC-BY-4.0', 'CC0-1.0'];

  it('passes for an allowed license', () => {
    assert.equal(checkLicense({ license: { spdx_id: 'Apache-2.0' } }, allowed).passed, true);
  });

  it('passes for MIT', () => {
    assert.equal(checkLicense({ license: { spdx_id: 'MIT' } }, allowed).passed, true);
  });

  it('fails for a disallowed license and mentions the SPDX ID', () => {
    const r = checkLicense({ license: { spdx_id: 'GPL-3.0' } }, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /GPL-3\.0/);
  });

  it('fails when license is null', () => {
    const r = checkLicense({ license: null }, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /No license detected/);
  });

  it('fails when license field is absent', () => {
    const r = checkLicense({}, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /No license detected/);
  });

  it('fails for NOASSERTION with custom license message', () => {
    const r = checkLicense({ license: { spdx_id: 'NOASSERTION' } }, allowed);
    assert.equal(r.passed, false);
    assert.match(r.detail, /Custom license text detected/);
  });
});

// ── checkRequiredFile ─────────────────────────────────────────────────────────

describe('checkRequiredFile', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'lint-files-'));
    await writeFile(path.join(tmpDir, 'README.md'), '');
    await writeFile(path.join(tmpDir, 'LICENSE'), '');
    await mkdir(path.join(tmpDir, '.github'));
    await writeFile(path.join(tmpDir, '.github', 'CONTRIBUTING.md'), '');
    await mkdir(path.join(tmpDir, 'docs'));
  });

  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('finds README.md in root', async () => {
    const r = await checkRequiredFile(tmpDir, { pattern: 'README*' });
    assert.equal(r.passed, true);
  });

  it('finds LICENSE in root', async () => {
    const r = await checkRequiredFile(tmpDir, { pattern: 'LICENSE*' });
    assert.equal(r.passed, true);
  });

  it('finds CONTRIBUTING in .github when search_paths includes it', async () => {
    const r = await checkRequiredFile(tmpDir, {
      pattern: 'CONTRIBUTING*',
      search_paths: ['.', '.github', 'docs'],
    });
    assert.equal(r.passed, true);
  });

  it('fails to find CONTRIBUTING when only searching root', async () => {
    const r = await checkRequiredFile(tmpDir, {
      pattern: 'CONTRIBUTING*',
      search_paths: ['.'],
    });
    assert.equal(r.passed, false);
    assert.match(r.detail, /\./);
  });

  it('fails when file does not exist', async () => {
    const r = await checkRequiredFile(tmpDir, { pattern: 'MISSING*' });
    assert.equal(r.passed, false);
    assert.ok(r.detail);
  });

  it('detail mentions all searched paths on failure', async () => {
    const r = await checkRequiredFile(tmpDir, {
      pattern: 'MISSING*',
      search_paths: ['.', 'docs'],
    });
    assert.match(r.detail, /\./);
    assert.match(r.detail, /docs/);
  });

  it('matches case-insensitively (readme.md matches README*)', async () => {
    const caseDir = await mkdtemp(path.join(tmpdir(), 'lint-case-'));
    try {
      await writeFile(path.join(caseDir, 'readme.md'), '');
      const r = await checkRequiredFile(caseDir, { pattern: 'README*' });
      assert.equal(r.passed, true);
    } finally {
      await rm(caseDir, { recursive: true });
    }
  });

  it('skips non-existent search_paths without error', async () => {
    const r = await checkRequiredFile(tmpDir, {
      pattern: 'README*',
      search_paths: ['nonexistent', '.'],
    });
    assert.equal(r.passed, true);
  });

  it('passes when file meets min_chars exactly', async () => {
    const sizeDir = await mkdtemp(path.join(tmpdir(), 'lint-size-'));
    try {
      await writeFile(path.join(sizeDir, 'README.md'), 'x'.repeat(300));
      const r = await checkRequiredFile(sizeDir, { pattern: 'README*', min_chars: 300 });
      assert.equal(r.passed, true);
    } finally {
      await rm(sizeDir, { recursive: true });
    }
  });

  it('fails when file exists but is below min_chars', async () => {
    const sizeDir = await mkdtemp(path.join(tmpdir(), 'lint-size-'));
    try {
      await writeFile(path.join(sizeDir, 'README.md'), 'x'.repeat(50));
      const r = await checkRequiredFile(sizeDir, { pattern: 'README*', min_chars: 300 });
      assert.equal(r.passed, false);
      assert.match(r.detail, /too short/);
      assert.match(r.detail, /50 chars/);
      assert.match(r.detail, /minimum is 300/);
    } finally {
      await rm(sizeDir, { recursive: true });
    }
  });

  it('passes without size check when min_chars is absent', async () => {
    const sizeDir = await mkdtemp(path.join(tmpdir(), 'lint-size-'));
    try {
      await writeFile(path.join(sizeDir, 'README.md'), 'tiny');
      const r = await checkRequiredFile(sizeDir, { pattern: 'README*' });
      assert.equal(r.passed, true);
    } finally {
      await rm(sizeDir, { recursive: true });
    }
  });
});

// ── buildIssueBody ────────────────────────────────────────────────────────────

describe('buildIssueBody', () => {
  const docsLink = 'https://example.com/standards';

  it('starts with the mandatory header', () => {
    const body = buildIssueBody([], docsLink);
    assert.ok(body.startsWith('## Mandatory Repository Configuration'));
  });

  it('includes the docs link', () => {
    const body = buildIssueBody([], docsLink);
    assert.match(body, /https:\/\/example\.com\/standards/);
  });

  it('marks failed checks with ❌', () => {
    const checks = [{ checkName: 'Repository Description', passed: false, detail: 'No description set' }];
    const body = buildIssueBody(checks, docsLink);
    assert.ok(body.includes('❌'));
    assert.ok(body.includes('No description set'));
  });

  it('marks passed checks with ✅', () => {
    const checks = [{ checkName: 'Repository Topics', passed: true }];
    const body = buildIssueBody(checks, docsLink);
    assert.ok(body.includes('✅'));
  });

  it('includes both ✅ and ❌ for mixed results', () => {
    const checks = [
      { checkName: 'Repository Description', passed: false, detail: 'No description set' },
      { checkName: 'Repository Topics', passed: true },
    ];
    const body = buildIssueBody(checks, docsLink);
    assert.ok(body.includes('✅'));
    assert.ok(body.includes('❌'));
  });

  it('includes the bot attribution line', () => {
    const body = buildIssueBody([], docsLink);
    assert.ok(body.includes('OSPO linting bot'));
  });
});

// ── metadataChecks / formatResultLine ─────────────────────────────────────────

describe('metadataChecks', () => {
  it('runs description, topics and license checks in this order', () => {
    const config = { description_length: { min: 5, max: 50 }, allowed_topics: [], allowed_licenses: ['MIT'] };
    const checks = metadataChecks({ description: 'A fine repo', topics: ['x'], license: { spdx_id: 'GPL-3.0-only' } }, config);
    assert.deepEqual(checks.map(c => [c.checkName, c.passed]), [
      ['Repository Description', true],
      ['Repository Topics', true],
      ['License Type', false],
    ]);
  });
});

describe('formatResultLine', () => {
  it('uses ✅/❌ for active and ✔️/✖️ for archived repos', () => {
    assert.equal(formatResultLine('a', [], false), '✅ a');
    assert.equal(formatResultLine('a', [{ checkName: 'X' }, { checkName: 'Y' }], false), '❌ a  [X, Y]');
    assert.equal(formatResultLine('a', [], true), '✔️ a');
    assert.equal(formatResultLine('a', [{ checkName: 'X' }], true), '✖️ a  [X]');
  });
});

// ── cloneOrUpdate ─────────────────────────────────────────────────────────────

/** Records simple-git calls; `fail` names operations ('fetch', 'reset') that should throw. */
function fakeGit({ fail = [] } = {}) {
  const calls = [];
  const op = name => async (...args) => {
    calls.push([name, ...args]);
    if (fail.includes(name)) throw new Error(`${name} failed`);
  };
  const git = dir => ({ dir, clone: op('clone'), fetch: op('fetch'), reset: op('reset') });
  git.calls = calls;
  return git;
}

describe('cloneOrUpdate', () => {
  let cacheDir;
  before(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'lint-clone-')); });
  after(async () => { await rm(cacheDir, { recursive: true }); });

  it('shallow-clones a repository that is not cached yet', async () => {
    const git = fakeGit();
    const logger = createMemoryLogger({ debug: true });
    await cloneOrUpdate('new', path.join(cacheDir, 'new'), 'org', { git, logger });
    assert.deepEqual(git.calls, [['clone', 'https://github.com/org/new.git', path.join(cacheDir, 'new'), ['--depth', '1']]]);
    assert.match(logger.output(), /Cloning new\.\.\./);
  });

  it('fetches and hard-resets an existing clone', async () => {
    await mkdir(path.join(cacheDir, 'cached'));
    const git = fakeGit();
    await cloneOrUpdate('cached', path.join(cacheDir, 'cached'), 'org', { git });
    assert.deepEqual(git.calls.map(c => c[0]), ['fetch', 'reset']);
  });

  it('tolerates a failed reset (empty remote)', async () => {
    await mkdir(path.join(cacheDir, 'empty'));
    const git = fakeGit({ fail: ['reset'] });
    await cloneOrUpdate('empty', path.join(cacheDir, 'empty'), 'org', { git });
    assert.deepEqual(git.calls.map(c => c[0]), ['fetch', 'reset']);
  });

  it('updates an existing clone with the real simple-git (no network)', async () => {
    // Guards the simple-git import and API: origin is a local repo, so only the update path runs.
    const { simpleGit } = await import('simple-git');
    const origin = path.join(cacheDir, 'origin');
    await mkdir(origin);
    const upstream = simpleGit(origin);
    await upstream.init();
    await upstream.addConfig('user.email', 'test@example.com').addConfig('user.name', 'Test');
    await writeFile(path.join(origin, 'README.md'), 'v1');
    await upstream.add('.').commit('v1');

    const clone = path.join(cacheDir, 'real-clone');
    await simpleGit().clone(origin, clone);
    await writeFile(path.join(origin, 'README.md'), 'v2');
    await upstream.add('.').commit('v2');

    await cloneOrUpdate('real-clone', clone, 'org');
    assert.equal(await readFile(path.join(clone, 'README.md'), 'utf8'), 'v2');
  });

  it('deletes and re-clones when the update fails', async () => {
    const dir = path.join(cacheDir, 'corrupt');
    await mkdir(dir);
    await writeFile(path.join(dir, 'junk'), 'x');
    const git = fakeGit({ fail: ['fetch'] });
    const logger = createMemoryLogger({ debug: true });
    await cloneOrUpdate('corrupt', dir, 'org', { git, logger });
    assert.deepEqual(git.calls.map(c => c[0]), ['fetch', 'clone']);
    assert.match(logger.output(), /Re-cloning corrupt \(update failed\)/);
    await assert.rejects(() => readdir(dir), { code: 'ENOENT' }, 'the old clone is removed before re-cloning');
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('run', () => {
  const org = 'test-org';
  let tmpDir;
  let cacheDir;
  let configPath;

  const goodRepo = name => ({
    name,
    description: 'A repository description that is long enough',
    topics: ['api'],
    license: { spdx_id: 'MIT' },
  });
  const repos = [
    goodRepo('good'),
    { ...goodRepo('bad'), description: '', topics: [] },
    goodRepo('fixed'),
    goodRepo('.github'),
    { ...goodRepo('old'), archived: true, license: null },
  ];
  const issues = { fixed: [{ number: 4, title: 'Mandatory Repository Configuration', state: 'open' }] };

  before(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'lint-run-'));
    cacheDir = path.join(tmpDir, 'cache');
    for (const name of ['good', 'fixed']) {
      await mkdir(path.join(cacheDir, name), { recursive: true });
      await writeFile(path.join(cacheDir, name, 'README.md'), 'hello');
    }
    await mkdir(path.join(cacheDir, 'bad'), { recursive: true });
    configPath = path.join(tmpDir, 'lint.yaml');
    await writeFile(configPath, [
      'issue_title: Mandatory Repository Configuration',
      'docs_link: https://docs.example',
      'allowed_licenses: [MIT]',
      'excluded_repos: [.github]',
      'required_files:',
      '  - pattern: "README*"',
      '    description: README File',
    ].join('\n'));
  });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  async function runLint(argv, fakeOptions = {}, { debug = false } = {}) {
    const gh = createFakeGitHub({ repos, issues, ...fakeOptions });
    const logger = createMemoryLogger({ debug });
    const git = fakeGit();
    const code = await run({ argv: ['--org', org, '--config', configPath, ...argv], github: gh, logger, git, cacheDir });
    return { gh, logger, git, code };
  }

  it('dry-run prints results, skipped repos and the planned issue changes', async t => {
    const { gh, logger, code } = await runLint(['--dry-run']);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    t.assert.snapshot(logger.output());
  });

  it('updates every active clone and none of the skipped repos', async () => {
    const { git } = await runLint(['--dry-run']);
    assert.deepEqual(git.calls.filter(c => c[0] === 'fetch').length, 3);
    assert.equal(git.calls.some(c => String(c[1]).includes('old') || String(c[1]).includes('.github')), false);
  });

  it('live run opens an issue for failures and closes resolved ones with a comment', async () => {
    const { gh } = await runLint([]);
    const [opened] = gh.state.issues.bad;
    assert.equal(opened.title, 'Mandatory Repository Configuration');
    assert.match(opened.body, /\| Repository Description \| ❌ Failed \| No description set \|/);
    assert.match(opened.body, /\| README File \| ❌ Failed \| File not found in \. \|/);
    assert.match(opened.body, /\(https:\/\/docs\.example\)/);

    const [closed] = gh.state.issues.fixed;
    assert.equal(closed.state, 'closed');
    assert.deepEqual(closed.comments, ['_All compliance checks now pass. Closing this issue automatically._']);
  });

  it('updates an existing issue for a repo that still fails', async () => {
    const { gh } = await runLint(['--dry-run'], { issues: { bad: [{ number: 11, title: 'Mandatory Repository Configuration', state: 'open' }] } });
    assert.deepEqual(gh.writes(), []);
    const live = await runLint([], { issues: { bad: [{ number: 11, title: 'Mandatory Repository Configuration', body: 'old', state: 'open' }] } });
    assert.match(live.gh.state.issues.bad[0].body, /No description set/);
    assert.equal(live.gh.callsTo('createIssue').length, 0);
  });

  it('prints failure details with --debug', async () => {
    const { logger } = await runLint(['--dry-run', '--debug'], {}, { debug: true });
    assert.match(logger.output(), /Cloning 3 repositories \(5 at a time\)/);
    assert.match(logger.output(), /     Repository Topics: No topics set/);
  });

  it('works for an org without repositories', async () => {
    const { logger, git } = await runLint([], { repos: [] });
    assert.equal(logger.output(), 'Results\n───────\n');
    assert.deepEqual(git.calls, []);
  });

  it('--json writes every check of the active repos and lists skipped repos', async t => {
    const file = path.join(tmpDir, 'out', 'lint_repos.json');
    const env = { GITHUB_SHA: 'abc123', GITHUB_REPOSITORY: 'allianz/ospo', GITHUB_RUN_ID: '7' };
    const gh = createFakeGitHub({ repos, issues });
    const logger = createMemoryLogger();
    const now = new Date('2026-11-03T02:00:00Z');
    const argv = ['--org', org, '--config', configPath, '--dry-run', '--json', file];
    assert.equal(await run({ argv, env, github: gh, logger, git: fakeGit(), cacheDir, now }), 0);
    assert.match(logger.output(), new RegExp(`\\nJSON written to ${file}\\n$`));

    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.ospo_sha, 'abc123');
    assert.equal(doc.run_url, 'https://github.com/allianz/ospo/actions/runs/7');
    assert.ok(doc.results.every(r => r.check in doc.catalogue && r.reason));
    t.assert.snapshot({ ...doc, config_file: '<config>' });
  });

  it('without --json writes no file and prints no JSON line', async () => {
    const { logger } = await runLint(['--dry-run']);
    assert.doesNotMatch(logger.output(), /JSON written/);
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe('JSON output', () => {
  const config = {
    description_length: { min: 30, max: 150 },
    allowed_topics: ['api'],
    allowed_licenses: ['MIT', 'Apache-2.0'],
    required_files: [
      { pattern: 'README*', description: 'Readme File', min_chars: 300 },
      { pattern: 'CONTRIBUTING*', search_paths: ['.', '.github'], description: 'Contributing File' },
      { pattern: 'NOTICE*' },
    ],
  };

  it('derives required-file check IDs from the pattern prefix', () => {
    assert.equal(requiredFileCheckId({ pattern: 'CONTRIBUTING*' }), 'lint/contributing');
    assert.equal(requiredFileCheckId({ pattern: 'Code_Of_Conduct*.md' }), 'lint/code-of-conduct');
  });

  it('loadConfig rejects required files without a unique check ID', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lint-ids-'));
    try {
      const dup = path.join(dir, 'dup.yaml');
      await writeFile(dup, 'issue_title: T\nrequired_files:\n  - pattern: "README*"\n  - pattern: "readme*.md"\n');
      await assert.rejects(() => loadConfig(dup), /pattern 'readme\*\.md' gives no unique check ID/);
      const empty = path.join(dir, 'empty.yaml');
      await writeFile(empty, 'issue_title: T\nrequired_files:\n  - pattern: "*"\n');
      await assert.rejects(() => loadConfig(empty), /pattern '\*' gives no unique check ID/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('gives every check a reason, also when it passes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lint-reasons-'));
    try {
      await writeFile(path.join(dir, 'README.md'), 'x'.repeat(300));
      await mkdir(path.join(dir, '.github'));
      await writeFile(path.join(dir, '.github', 'CONTRIBUTING.md'), 'c');
      await writeFile(path.join(dir, 'NOTICE'), 'n');
      const repo = { description: 'A repository description that is long enough', topics: ['api'], license: { spdx_id: 'MIT' } };
      const checks = await runChecks(repo, config, dir);
      assert.deepEqual(checks.map(c => [c.id, c.passed, c.detail]), [
        ['lint/description', true, 'Description has 44 chars'],
        ['lint/topics', true, 'Topics: api'],
        ['lint/license-type', true, "'MIT' is in the approved list"],
        ['lint/readme', true, 'README.md found (300 chars)'],
        ['lint/contributing', true, 'CONTRIBUTING.md found in .github'],
        ['lint/notice', true, 'NOTICE found'],
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('builds the catalogue from the configuration', () => {
    const catalogue = buildCatalogue(config, { sha: 'abc' });
    assert.deepEqual(Object.keys(catalogue), [
      'lint/description', 'lint/topics', 'lint/license-type', 'lint/readme', 'lint/contributing', 'lint/notice',
    ]);
    assert.equal(catalogue['lint/description'].documentation.short, 'The repository description is set and has 30 to 150 characters.');
    assert.equal(catalogue['lint/topics'].documentation.short, 'The repository has 1 to 5 topics, all from the approved topic list.');
    assert.match(catalogue['lint/license-type'].documentation.fix, /\(MIT, Apache-2\.0\)/);
    assert.equal(catalogue['lint/readme'].documentation.short, 'A file README* exists in ., with at least 300 characters.');
    assert.equal(catalogue['lint/contributing'].name, 'Contributing File');
    assert.equal(catalogue['lint/contributing'].documentation.fix, 'Add a CONTRIBUTING* file in ., .github.');
    assert.equal(catalogue['lint/notice'].name, 'NOTICE*');
    assert.equal(
      catalogue['lint/readme'].documentation.url,
      'https://github.com/allianz/ospo/blob/abc/scripts/spec/lint_repos_spec.md#readme-file',
    );
    const anyTopic = buildCatalogue({ ...config, allowed_topics: [] });
    assert.equal(anyTopic['lint/topics'].documentation.short, 'The repository has 1 to 5 topics.');
    assert.equal(anyTopic['lint/topics'].documentation.fix, 'Add 1 to 5 topics in the About section of the repository.');
  });

  it('turns checks into results and archived/excluded repos into skipped entries', () => {
    const catalogue = buildCatalogue(config);
    const checked = [{
      repo: 'a',
      checks: [
        { id: 'lint/description', passed: false, detail: 'No description set' },
        { id: 'lint/topics', passed: true, detail: 'Topics: api' },
      ],
    }];
    const { results, skipped } = buildJsonResults({ checked, archived: [{ name: 'old' }], excluded: [{ name: '.github' }], catalogue });
    assert.deepEqual(results.map(r => [r.repo, r.check, r.name, r.result, r.reason]), [
      ['a', 'lint/description', 'Repository Description', 'fail', 'No description set'],
      ['a', 'lint/topics', 'Repository Topics', 'pass', 'Topics: api'],
    ]);
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: '.github', reason: 'excluded_repos' }]);
  });
});
