import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  checkDescription,
  checkTopics,
  checkLicense,
  checkRequiredFile,
  buildIssueBody,
} from './lint_repos.js';

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
