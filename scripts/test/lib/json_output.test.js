import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { repoRoot } from '../../lib/config.js';
import {
  DEFAULT_OSPO_REPO,
  buildHeader,
  buildJsonDocument,
  checkResult,
  headingSlug,
  resolveOspoSha,
  runUrl,
  skippedRepos,
  specCatalogue,
  specUrl,
  writeJsonReport,
} from '../../lib/json_output.js';

const ACTIONS_ENV = {
  GITHUB_SHA: 'abc123',
  GITHUB_SERVER_URL: 'https://github.example',
  GITHUB_REPOSITORY: 'acme/ospo',
  GITHUB_RUN_ID: '42',
};

const fakeGit = revparse => dir => ({ dir, revparse: async args => revparse(dir, args) });

describe('resolveOspoSha', () => {
  it('prefers GITHUB_SHA', async () => {
    assert.equal(await resolveOspoSha({ GITHUB_SHA: 'abc' }, fakeGit(() => 'unused')), 'abc');
  });

  it('falls back to HEAD of the repository root', async () => {
    let seen;
    const sha = await resolveOspoSha({}, fakeGit((dir, args) => { seen = [dir, args]; return 'def456\n'; }));
    assert.equal(sha, 'def456');
    assert.deepEqual(seen, [repoRoot, ['HEAD']]);
  });

  it('returns null when git fails or returns nothing', async () => {
    assert.equal(await resolveOspoSha({}, fakeGit(() => { throw new Error('not a repo'); })), null);
    assert.equal(await resolveOspoSha({}, fakeGit(() => '')), null);
  });

  it('reads the real checkout by default', async () => {
    const sha = await resolveOspoSha();
    assert.ok(sha === null || /^[0-9a-f]{40}$/.test(sha));
  });
});

describe('runUrl', () => {
  it('links the Actions run', () => {
    assert.equal(runUrl(ACTIONS_ENV), 'https://github.example/acme/ospo/actions/runs/42');
    assert.equal(runUrl({ GITHUB_REPOSITORY: 'acme/ospo', GITHUB_RUN_ID: '7' }), 'https://github.com/acme/ospo/actions/runs/7');
  });

  it('is null outside Actions', () => {
    assert.equal(runUrl({}), null);
    assert.equal(runUrl(), null);
    assert.equal(runUrl({ GITHUB_REPOSITORY: 'acme/ospo' }), null);
  });
});

describe('headingSlug / specUrl / specCatalogue', () => {
  it('builds GitHub heading anchors', () => {
    assert.equal(headingSlug('License Type'), 'license-type');
    assert.equal(headingSlug('SBOM Available'), 'sbom-available');
    assert.equal(headingSlug(' README* (root) '), 'readme-root');
  });

  it('pins the URL to the commit, or main when unknown', () => {
    assert.equal(
      specUrl('lint_repos_spec.md', 'License Type', { sha: 'abc', env: ACTIONS_ENV }),
      'https://github.example/acme/ospo/blob/abc/scripts/spec/lint_repos_spec.md#license-type',
    );
    assert.equal(
      specUrl('lint_repos_spec.md', 'License Type'),
      `https://github.com/${DEFAULT_OSPO_REPO}/blob/main/scripts/spec/lint_repos_spec.md#license-type`,
    );
  });

  it('builds catalogue entries with name and documentation', () => {
    const entry = specCatalogue('x_spec.md', { sha: 's' });
    assert.deepEqual(entry('Some Check', 'Rule.', 'Fix it.'), {
      name: 'Some Check',
      documentation: { url: `https://github.com/${DEFAULT_OSPO_REPO}/blob/s/scripts/spec/x_spec.md#some-check`, short: 'Rule.', fix: 'Fix it.' },
    });
    assert.match(specCatalogue('x_spec.md')('A', 's', 'f').documentation.url, /\/blob\/main\//);
  });
});

describe('buildHeader', () => {
  let tmpDir;
  before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'json-output-')); });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('fills every header field', async () => {
    const configPath = path.join(tmpDir, 'tool.yaml');
    await writeFile(configPath, 'issue_title: T\n');
    const header = await buildHeader({
      tool: 'lint_repos', org: 'acme', configPath, issueTitle: 'T', env: ACTIONS_ENV, now: new Date('2026-11-03T02:00:00.123Z'),
    });
    assert.deepEqual(header, {
      tool: 'lint_repos',
      run_at: '2026-11-03T02:00:00Z',
      org: 'acme',
      ospo_sha: 'abc123',
      config_file: path.relative(repoRoot, configPath).split(path.sep).join('/'),
      config_sha256: createHash('sha256').update('issue_title: T\n').digest('hex'),
      run_url: 'https://github.example/acme/ospo/actions/runs/42',
      issue_title: 'T',
    });
  });

  it('gives the config path relative to the repository root and null for unknowns', async () => {
    const header = await buildHeader({
      tool: 'archive_repos', org: 'acme', configPath: path.join(repoRoot, 'config', 'archive_repos.yaml'), git: fakeGit(() => { throw new Error(); }),
    });
    assert.equal(header.config_file, 'config/archive_repos.yaml');
    assert.equal(header.ospo_sha, null);
    assert.equal(header.run_url, null);
    assert.equal(header.issue_title, null);
    assert.match(header.run_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

describe('checkResult', () => {
  const catalogue = { 'x/check': { name: 'X Check' } };

  it('builds a result row from passed or result', () => {
    assert.deepEqual(checkResult('r', 'x/check', catalogue, { passed: true, reason: 'ok' }), {
      repo: 'r', check: 'x/check', name: 'X Check', result: 'pass', score: null, reason: 'ok', details: [],
    });
    assert.equal(checkResult('r', 'x/check', catalogue, { passed: false, reason: 'no' }).result, 'fail');
    assert.equal(checkResult('r', 'x/check', catalogue, { result: 'na', reason: 'n/a', details: ['Info: x'] }).details[0], 'Info: x');
  });

  it('rejects checks missing from the catalogue and unknown results', () => {
    assert.throws(() => checkResult('r', 'x/other', catalogue, { passed: true, reason: '' }), /x\/other is not in the catalogue/);
    assert.throws(() => checkResult('r', 'x/check', catalogue, { result: 'maybe', reason: '' }), /Invalid result 'maybe'/);
  });
});

describe('skippedRepos / buildJsonDocument / writeJsonReport', () => {
  it('lists skipped repositories with one reason', () => {
    assert.deepEqual(skippedRepos([{ name: 'a' }, { name: 'b' }], 'archived'), [
      { repo: 'a', reason: 'archived' },
      { repo: 'b', reason: 'archived' },
    ]);
  });

  it('always has results, catalogue, skipped and errors after the header', () => {
    const doc = buildJsonDocument({ tool: 't' }, { results: [], catalogue: {} });
    assert.deepEqual(Object.keys(doc), ['tool', 'results', 'catalogue', 'skipped', 'errors']);
    assert.deepEqual(doc.skipped, []);
    assert.deepEqual(doc.errors, []);
  });

  it('writes pretty JSON and creates the directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'json-write-'));
    try {
      const file = path.join(dir, 'out', 'nested', 'x.json');
      await writeJsonReport(file, { a: 1 });
      assert.equal(await readFile(file, 'utf8'), '{\n  "a": 1\n}\n');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
