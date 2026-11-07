import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CHECKS, TOOL, buildCatalogue, buildJsonResults, loadConfig, run } from '../by_construction.js';
import { createFakeGitHub } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'by-construction-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

async function writeConfig(name, lines) {
  const file = path.join(tmpDir, name);
  await writeFile(file, lines.join('\n'));
  return file;
}

// ── Config ───────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('defaults excluded_repos to an empty list, also for an empty file', async () => {
    assert.deepEqual(await loadConfig(await writeConfig('empty.yaml', ['# only a comment'])), { excluded_repos: [] });
  });

  it('keeps a configured excluded_repos list', async () => {
    const config = await loadConfig(await writeConfig('excluded.yaml', ['excluded_repos:', '  - legacy']));
    assert.deepEqual(config.excluded_repos, ['legacy']);
  });
});

// ── JSON output ──────────────────────────────────────────────────────────────

describe('buildCatalogue', () => {
  const catalogue = buildCatalogue({ sha: 'abc' });

  it('documents both checks under their spec headings, pinned to the sha', () => {
    assert.deepEqual(Object.keys(catalogue), ['by-construction/source-archives', 'by-construction/sbom-available']);
    assert.deepEqual(Object.values(catalogue).map(e => e.documentation.url), [
      'https://github.com/allianz/ospo/blob/abc/scripts/spec/by_construction_spec.md#source-archives',
      'https://github.com/allianz/ospo/blob/abc/scripts/spec/by_construction_spec.md#sbom-available',
    ]);
  });

  it('says that the checks are no tests and has no fix', () => {
    for (const entry of Object.values(catalogue)) {
      assert.match(entry.documentation.short, /^Not a test; always passes\. /);
      assert.equal(JSON.parse(JSON.stringify(entry)).documentation.fix, undefined);
    }
  });

  it('pins to main without a sha', () => {
    assert.match(buildCatalogue()['by-construction/sbom-available'].documentation.url, /\/blob\/main\//);
  });
});

describe('buildJsonResults', () => {
  const catalogue = buildCatalogue({ sha: 'abc' });

  it('writes one pass per check and active repo, sorted by repo, and skips the others', () => {
    const { results, skipped } = buildJsonResults({
      active: [{ name: 'zeta' }, { name: 'alpha' }],
      archived: [{ name: 'old' }],
      excluded: [{ name: 'legacy' }],
      catalogue,
    });
    assert.deepEqual(results.map(r => [r.repo, r.check, r.result]), [
      ['alpha', 'by-construction/source-archives', 'pass'],
      ['alpha', 'by-construction/sbom-available', 'pass'],
      ['zeta', 'by-construction/source-archives', 'pass'],
      ['zeta', 'by-construction/sbom-available', 'pass'],
    ]);
    assert.ok(results.every(r => r.reason === CHECKS[r.check].reason && r.reason.startsWith('Guaranteed by GitHub')));
    assert.ok(results.every(r => r.score === null && r.details.length === 0));
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: 'legacy', reason: 'excluded_repos' }]);
  });

  it('writes no results without active repos', () => {
    assert.deepEqual(buildJsonResults({ active: [], archived: [], excluded: [], catalogue }), { results: [], skipped: [] });
  });
});

// ── run() ────────────────────────────────────────────────────────────────────

describe('run', () => {
  const repos = [
    { name: 'zeta' },
    { name: 'alpha' },
    { name: 'old', archived: true },
    { name: 'legacy' },
  ];
  let configPath;
  before(async () => { configPath = await writeConfig('by_construction.yaml', ['excluded_repos:', '  - legacy']); });

  async function runTool(argv, { debug = false, env } = {}) {
    const gh = createFakeGitHub({ repos });
    const logger = createMemoryLogger({ debug });
    const code = await run({
      argv: ['--org', org, '--config', configPath, ...argv],
      github: gh,
      logger,
      env,
      now: new Date('2026-11-03T02:00:00Z'),
    });
    return { gh, logger, code };
  }

  it('dry-run prints the repo counts and the checks, and changes nothing', async t => {
    const { gh, logger, code } = await runTool(['--dry-run', '--debug'], { debug: true });
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    t.assert.snapshot(logger.output());
  });

  it('omits empty archived and excluded lists from the debug output', async () => {
    const gh = createFakeGitHub({ repos: [{ name: 'alpha' }] });
    const logger = createMemoryLogger({ debug: true });
    await run({ argv: ['--org', org, '--config', configPath, '--debug'], github: gh, logger });
    assert.doesNotMatch(logger.output(), /Archived repos|Excluded repos/);
  });

  it('--json writes two checks per active repo and lists skipped repos', async t => {
    const file = path.join(tmpDir, 'out', 'by_construction.json');
    const { logger } = await runTool(['--json', file], { env: { GITHUB_SHA: 'abc123' } });
    assert.match(logger.output(), /\nJSON written to .*by_construction\.json\n$/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.tool, TOOL);
    assert.equal(doc.issue_title, null);
    assert.equal(doc.results.length, 4);
    assert.ok(doc.results.every(r => r.check in doc.catalogue && r.result === 'pass'));
    t.assert.snapshot({ ...doc, config_file: '<config>' });
  });

  it('requires a token without an injected GitHub', async () => {
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath], env: {} }), /GITHUB_TOKEN/);
  });
});
