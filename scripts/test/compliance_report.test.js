import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  NotesError,
  STATUSES,
  assessRequirements,
  buildData,
  checkInlineMarkdown,
  computeScope,
  computeSummary,
  excludedFailResults,
  loadReportConfig,
  mappedChecks,
  mergeHistory,
  mergeToolFiles,
  parseNotes,
  readInputs,
  readNotes,
  readPreviousReport,
  latestDataPath,
  DEFAULT_REPORTS_PATH,
  repositoryOutcome,
  indexResults,
  run,
  unknownChecks,
  validateToolFile,
} from '../compliance_report.js';
import { ScriptError } from '../lib/cli.js';
import { repoRoot } from '../lib/config.js';
import { buildCatalogue as archiveCatalogue } from '../archive_repos.js';
import { CHECK as ADVISORIES_CHECK } from '../advisories_check.js';
import { CHECKS as BY_CONSTRUCTION_CHECKS } from '../by_construction.js';
import { buildCatalogue as licenseCatalogue } from '../license_scan.js';
import { buildCatalogue as lintCatalogue, loadConfig as loadLintConfig } from '../lint_repos.js';
import { RELEASE_NOTES, VERSIONING } from '../releases_check.js';
import { checkId, loadConfig as loadScorecardConfig } from '../scorecard_check.js';
import { DATA_PLACEHOLDER } from '../lib/report_html.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-03T02:00:00Z');

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'compliance-report-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const entry = (name, threshold) => ({
  name,
  ...(threshold !== undefined ? { threshold } : {}),
  documentation: { url: `https://example.test/spec#${name}`, short: `${name} rule.`, fix: `Fix ${name}.` },
});
const row = (repo, check, result, score = null) => ({ repo, check, name: check, result, score, reason: `${check} ${result}`, details: [] });

function toolDoc(tool, { catalogue, results = [], skipped = [], errors = [], extra = {} }) {
  return {
    tool,
    run_at: '2026-11-03T02:00:00Z',
    org,
    ospo_sha: 'abc123',
    config_file: `config/${tool}.yaml`,
    config_sha256: 'f'.repeat(64),
    run_url: null,
    issue_title: null,
    ...extra,
    results,
    catalogue,
    skipped,
    errors,
  };
}

/**
 * Active: alpha, beta, gamma (excluded by lint_repos). Archived: old (before), stale (archived in
 * this run, so its lint result is dropped). by_construction.json is missing, releases_check.json invalid.
 */
const DOCS = {
  lint_repos: toolDoc('lint_repos', {
    extra: { issue_title: 'Mandatory Repository Configuration' },
    catalogue: { 'lint/contributing': entry('Contributing File'), 'lint/description': entry('Repository Description') },
    results: [
      row('alpha', 'lint/contributing', 'pass'), row('alpha', 'lint/description', 'fail'),
      row('beta', 'lint/contributing', 'fail'), row('beta', 'lint/description', 'pass'),
      row('stale', 'lint/contributing', 'pass'), row('stale', 'lint/description', 'pass'),
    ],
    skipped: [{ repo: 'gamma', reason: 'excluded_repos' }, { repo: 'old', reason: 'archived' }],
  }),
  scorecard_check: toolDoc('scorecard_check', {
    extra: { source: 'scorecard CLI', scorecard_version: 'v5.6.0', scorecard_commit: 'deadbeef', repositories: [{ repo: 'alpha', score: 7 }] },
    catalogue: {
      'scorecard/ci-tests': entry('CI-Tests', 8),
      'scorecard/code-review': entry('Code-Review', 7),
      'scorecard/binary-artifacts': entry('Binary-Artifacts', 10),
    },
    results: [
      row('alpha', 'scorecard/ci-tests', 'pass', 10), row('alpha', 'scorecard/code-review', 'pass', 10), row('alpha', 'scorecard/binary-artifacts', 'fail', 0),
      row('beta', 'scorecard/ci-tests', 'na'),
      row('gamma', 'scorecard/ci-tests', 'pass', 9), row('gamma', 'scorecard/code-review', 'fail', 3),
    ],
    skipped: [{ repo: 'old', reason: 'archived' }],
    errors: [
      { repo: 'beta', check: 'scorecard/code-review', reason: 'internal error: boom' },
      { repo: 'beta', check: 'scorecard/binary-artifacts', reason: 'internal error: boom' },
    ],
  }),
  archive_repos: toolDoc('archive_repos', {
    catalogue: { 'archive/activity-checked': entry('Activity Checked'), 'archive/recent-activity': entry('Recent Activity') },
    results: ['alpha', 'beta', 'gamma'].flatMap(repo => [row(repo, 'archive/activity-checked', 'pass'), row(repo, 'archive/recent-activity', 'pass')]),
    skipped: [{ repo: 'stale', reason: 'archived in this run' }, { repo: 'old', reason: 'archived' }],
  }),
};

const INPUTS = [
  { file: 'lint_repos.json', script: 'scripts/lint_repos.js' },
  { file: 'scorecard.json', script: 'scripts/scorecard_check.js' },
  { file: 'archive_repos.json', script: 'scripts/archive_repos.js' },
  { file: 'by_construction.json', script: 'scripts/by_construction.js' },
  { file: 'releases_check.json', script: 'scripts/releases_check.js' },
];

const REQUIREMENTS = {
  'GV.01': { title: 'Contribute', level: 'MUST', text: [{ level: 'MUST', text: 'Contribution MUST be documented.' }], implementation: 'CONTRIBUTING file.', checks: ['lint/contributing'] },
  'GV.02': { title: 'Protected', level: 'MUST', text: [], implementation: 'Ruleset.', checks: ['scorecard/ci-tests', 'scorecard/code-review'] },
  'QA.01': { title: 'SBOM', level: 'MUST', implementation: 'Dependency graph.', checks: ['by-construction/sbom-available'] },
  'QA.02': { title: 'Public', level: 'MUST', checks: [] },
  'BR.02': { title: 'Versions', level: 'MUST', checks: ['releases/versioning'] },
  'BR.06': { title: 'Reproducible', level: 'SHOULD', checks: [] },
  'DE.01': { title: 'Discontinuation', level: 'SHOULD', checks: ['archive/activity-checked'] },
  'DE.02': { title: 'Migration', level: 'MAY', checks: ['archive/activity-checked'] },
};

const NOTES = [
  '## Key messages',
  '',
  '- **Release integrity is the weakest area.** See `BR.03` and the [template](https://github.com/allianz/ospo/issues/1).',
  '',
  '## Needs attention',
  '',
  '- **Decision: license review** (Legal, by 30 Nov 2026).',
  '',
].join('\n');

async function writeReportConfig(name, overrides = {}) {
  const file = path.join(tmpDir, name);
  const config = {
    key: 'test',
    framework: { id: 'fw', title: 'Test Framework', version: '1.0', url: 'https://example.test/fw', chapters: { GV: 'Governance', QA: 'Quality', BR: 'Build', DE: 'Decommissioning' } },
    inputs: INPUTS,
    requirements: REQUIREMENTS,
    ...overrides,
  };
  await writeFile(file, yaml.dump(config));
  return file;
}

/** Writes the tool files: three valid, releases_check.json invalid, by_construction.json missing. */
async function writeToolFiles(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'lint_repos.json'), JSON.stringify(DOCS.lint_repos, null, 2));
  await writeFile(path.join(dir, 'scorecard.json'), JSON.stringify(DOCS.scorecard_check, null, 2));
  await writeFile(path.join(dir, 'archive_repos.json'), JSON.stringify(DOCS.archive_repos, null, 2));
  await writeFile(path.join(dir, 'releases_check.json'), '{ not json');
  return dir;
}

const PREVIOUS = {
  report_id: 'OSPO-CR-TEST-2026-10',
  history: [
    { month: '2026-11', compliance_pct: 1, failing_repositories: 9, coverage: {} },
    { month: '2026-09', compliance_pct: 60, failing_repositories: 3, coverage: { 'GV.01': 50 } },
    { month: '2026-10', compliance_pct: 65, failing_repositories: 3, coverage: { 'GV.01': 50 } },
  ],
};

/** A fake simple-git factory: origin/main is "prevsha" and holds `files` (path → content). */
function fakeGit(files = {}) {
  return () => ({
    revparse: async ([ref]) => (ref === 'origin/main' ? 'prevsha\n' : 'headsha\n'),
    raw: async ([command, , , sha]) => {
      assert.equal(command, 'ls-tree');
      return sha === 'prevsha' ? `${Object.keys(files).join('\n')}\n` : '';
    },
    show: async ([spec]) => {
      const [sha, file] = spec.split(':');
      if (sha !== 'prevsha' || !(file in files)) throw new Error(`fatal: path '${file}' does not exist in '${sha}'`);
      return files[file];
    },
  });
}

const config = async () => loadReportConfig(await writeReportConfig('base.yaml'));

// ── Config ───────────────────────────────────────────────────────────────────

describe('loadReportConfig', () => {
  it('turns the requirements into a list in file order, with chapter and defaults', async () => {
    const { requirements } = await config();
    assert.deepEqual(requirements.map(r => r.id), Object.keys(REQUIREMENTS));
    assert.deepEqual(requirements[3], { id: 'QA.02', chapter: 'QA', level: 'MUST', title: 'Public', text: [], implementation: '', checks: [] });
  });

  const cases = [
    ['a missing field', { inputs: [] }, /Config missing required field: inputs/],
    ['an invalid key', { key: 'BSI' }, /key must consist of a-z, 0-9 and -: 'BSI'/],
    ['an input without script', { inputs: [{ file: 'x.json' }] }, /every input needs file and script/],
    ['an unknown chapter', { requirements: { 'XX.01': { title: 't', level: 'MUST', checks: [] } } }, /chapter XX is not in framework.chapters/],
    ['an invalid level', { requirements: { 'GV.01': { title: 't', level: 'MUSTN', checks: [] } } }, /level must be one of MUST, SHOULD, MAY/],
    ['a missing title', { requirements: { 'GV.01': { level: 'MUST', checks: [] } } }, /GV.01: title is missing/],
    ['checks that are no list', { requirements: { 'GV.01': { title: 't', level: 'MUST' } } }, /checks must be a list/],
  ];
  for (const [label, overrides, message] of cases) {
    it(`rejects ${label}`, async () => {
      await assert.rejects(async () => loadReportConfig(await writeReportConfig('bad.yaml', overrides)), message);
    });
  }
});

// ── Validation and inputs ────────────────────────────────────────────────────

describe('validateToolFile', () => {
  const input = { file: 'lint_repos.json', script: 'scripts/lint_repos.js' };
  const doc = DOCS.lint_repos;

  it('accepts a valid file', () => {
    assert.deepEqual(validateToolFile(doc, input, org), []);
  });

  it('rejects anything but an object', () => {
    assert.deepEqual(validateToolFile([], input, org), ['not a JSON object']);
    assert.deepEqual(validateToolFile(null, input, org), ['not a JSON object']);
  });

  it('names missing header fields, a wrong tool or org and broken lists', () => {
    const { run_url: _url, issue_title: _title, ...rest } = doc;
    assert.deepEqual(validateToolFile({ ...rest, tool: 'other', org: 'x', catalogue: [], errors: null }, input, org), [
      'missing header fields: run_url, issue_title',
      "tool is 'other', expected 'lint_repos'",
      "org is 'x', expected 'test-org'",
      'catalogue must be an object',
      'errors must be a list',
    ]);
  });

  it('rejects unknown checks, invalid results and duplicate results', () => {
    const results = [row('a', 'lint/contributing', 'ok'), row('a', 'lint/unknown', 'pass'), row('a', 'lint/contributing', 'pass')];
    assert.deepEqual(validateToolFile({ ...doc, results }, input, org), [
      "invalid result 'ok' for a lint/contributing",
      'check lint/unknown of a is not in the catalogue',
      'duplicate result for a lint/contributing',
    ]);
  });
});

describe('readInputs', () => {
  it('reads valid files and marks missing and invalid ones', async () => {
    const dir = await writeToolFiles(path.join(tmpDir, 'inputs'));
    await writeFile(path.join(dir, 'archive_repos.json'), JSON.stringify({ ...DOCS.archive_repos, org: 'other' }));
    const { inputs, docs } = await readInputs(dir, INPUTS, org);
    assert.deepEqual(inputs.map(i => [i.file, i.status]), [
      ['lint_repos.json', 'ok'], ['scorecard.json', 'ok'], ['archive_repos.json', 'invalid'], ['by_construction.json', 'missing'], ['releases_check.json', 'invalid'],
    ]);
    assert.deepEqual(docs.map(d => d.tool), ['lint_repos', 'scorecard_check']);
    assert.deepEqual(inputs[2].problems, ["org is 'other', expected 'test-org'"]);
    assert.match(inputs[4].problems[0], /^not valid JSON: /);
    assert.equal(inputs[3].sha256, null);
    assert.match(inputs[0].sha256, /^[0-9a-f]{64}$/);
  });

  it('copies the shown header fields and counts, plus source and scorecard_version where present', async () => {
    const dir = await writeToolFiles(path.join(tmpDir, 'inputs-header'));
    const { inputs } = await readInputs(dir, INPUTS.slice(0, 2), org);
    assert.deepEqual(Object.keys(inputs[0]), ['file', 'script', 'status', 'sha256', 'tool', 'run_at', 'ospo_sha', 'config_file', 'config_sha256', 'run_url', 'issue_title', 'counts']);
    assert.deepEqual(inputs[0].counts, { results: 6, skipped: 2, errors: 0 });
    assert.equal(inputs[1].scorecard_version, 'v5.6.0');
    assert.equal(inputs[1].source, 'scorecard CLI');
    assert.equal('scorecard_commit' in inputs[1], false);
  });

  it('throws on read errors other than a missing file', async () => {
    const dir = path.join(tmpDir, 'inputs-dir');
    await mkdir(path.join(dir, 'lint_repos.json'), { recursive: true });
    await assert.rejects(() => readInputs(dir, INPUTS.slice(0, 1), org), /EISDIR/);
  });
});

// ── Merge ────────────────────────────────────────────────────────────────────

describe('computeScope', () => {
  it('collects active repositories from results, skipped and errors, and archived ones from skip reasons', () => {
    assert.deepEqual(computeScope(Object.values(DOCS)), { active: ['alpha', 'beta', 'gamma'], archived: ['old', 'stale'] });
  });

  it('ignores error rows without a repository', () => {
    const doc = toolDoc('x', { catalogue: {}, errors: [{ check: 'x/y', reason: 'r' }] });
    assert.deepEqual(computeScope([doc]), { active: [], archived: [] });
  });
});

describe('mergeToolFiles', () => {
  const docs = Object.values(DOCS);
  const mapped = new Set(['lint/contributing', 'scorecard/ci-tests', 'scorecard/code-review', 'archive/activity-checked']);
  const merged = mergeToolFiles(docs, mapped, computeScope(docs));

  it('keeps only mapped checks, adds the tool and drops name and fix', () => {
    assert.deepEqual(Object.keys(merged.catalogue), ['archive/activity-checked', 'lint/contributing', 'scorecard/ci-tests', 'scorecard/code-review']);
    assert.deepEqual(merged.catalogue['scorecard/ci-tests'], {
      tool: 'scorecard_check', threshold: 8, documentation: { url: 'https://example.test/spec#CI-Tests', short: 'CI-Tests rule.' },
    });
    assert.deepEqual(merged.catalogue['lint/contributing'].tool, 'lint_repos');
  });

  it('keeps repo, check and result, score only for scored checks, and drops archived repositories', () => {
    assert.deepEqual(merged.results.slice(0, 3), [
      { repo: 'alpha', check: 'lint/contributing', result: 'pass' },
      { repo: 'beta', check: 'lint/contributing', result: 'fail' },
      { repo: 'alpha', check: 'scorecard/ci-tests', result: 'pass', score: 10 },
    ]);
    assert.ok(merged.results.every(r => r.repo !== 'stale' && mapped.has(r.check)));
    assert.deepEqual(merged.results.find(r => r.repo === 'beta' && r.check === 'scorecard/ci-tests'), { repo: 'beta', check: 'scorecard/ci-tests', result: 'na', score: null });
  });

  it('adds the tool to skipped and errors and keeps errors of mapped checks only', () => {
    assert.deepEqual(merged.skipped[0], { tool: 'lint_repos', repo: 'gamma', reason: 'excluded_repos' });
    assert.deepEqual(merged.errors, [{ tool: 'scorecard_check', repo: 'beta', check: 'scorecard/code-review', reason: 'internal error: boom' }]);
  });

  it('keeps errors without a check and fills missing fields with null', () => {
    const doc = toolDoc('x', { catalogue: {}, errors: [{ reason: 'tool broke' }] });
    assert.deepEqual(mergeToolFiles([doc], mapped, { active: [] }).errors, [{ tool: 'x', repo: null, check: null, reason: 'tool broke' }]);
  });

  it('keeps a missing score as null and a missing documentation as empty fields', () => {
    const doc = toolDoc('s', { catalogue: { 's/x': { name: 'X', threshold: 5 } }, results: [{ repo: 'a', check: 's/x', result: 'na' }] });
    const out = mergeToolFiles([doc], new Set(['s/x']), { active: ['a'] });
    assert.deepEqual(out.results, [{ repo: 'a', check: 's/x', result: 'na', score: null }]);
    assert.deepEqual(out.catalogue['s/x'].documentation, { url: undefined, short: undefined });
  });

  it('stops on a check defined by two tools', () => {
    const twin = toolDoc('other', { catalogue: { 'lint/contributing': entry('Contributing File') } });
    assert.throws(() => mergeToolFiles([DOCS.lint_repos, twin], mapped, { active: [] }), err =>
      err instanceof ScriptError && err.message === 'Check lint/contributing is defined by lint_repos and other');
  });
});

describe('excludedFailResults', () => {
  const docs = Object.values(DOCS);
  const scope = computeScope(docs);

  it('fails every mapped check of the tool that excluded an active repository', () => {
    assert.deepEqual(excludedFailResults(docs, new Set(['lint/contributing', 'scorecard/ci-tests']), scope), [
      { repo: 'gamma', check: 'lint/contributing', result: 'fail' },
    ]);
  });

  it('adds a null score for scored checks and ignores excluded archived repositories', () => {
    const doc = toolDoc('scorecard_check', {
      catalogue: { 'scorecard/ci-tests': entry('CI-Tests', 8) },
      skipped: [{ repo: 'gamma', reason: 'excluded_repos' }, { repo: 'old', reason: 'excluded_repos' }],
    });
    assert.deepEqual(excludedFailResults([doc], new Set(['scorecard/ci-tests']), scope), [
      { repo: 'gamma', check: 'scorecard/ci-tests', result: 'fail', score: null },
    ]);
  });
});

// ── Compute ──────────────────────────────────────────────────────────────────

describe('repositoryOutcome', () => {
  const index = indexResults([
    { repo: 'a', check: 'x', result: 'pass' }, { repo: 'a', check: 'y', result: 'na' },
    { repo: 'b', check: 'x', result: 'fail' },
    { repo: 'c', check: 'x', result: 'na' }, { repo: 'c', check: 'y', result: 'na' },
  ]);
  it('is failing on any fail, also with missing results', () => assert.equal(repositoryOutcome('b', ['x', 'y'], index), 'failing'));
  it('is no_data when a check has no result and none fails', () => assert.equal(repositoryOutcome('a', ['x', 'z'], index), 'no_data'));
  it('is not_applicable when all results are na', () => assert.equal(repositoryOutcome('c', ['x', 'y'], index), 'not_applicable'));
  it('is passing when the results pass or are na', () => assert.equal(repositoryOutcome('a', ['x', 'y'], index), 'passing'));
});

describe('assessRequirements and computeSummary', () => {
  const docs = Object.values(DOCS);
  let assessed;
  let summary;
  before(async () => {
    const { requirements } = await config();
    const mapped = mappedChecks(requirements);
    const scope = computeScope(docs);
    const results = [...mergeToolFiles(docs, mapped, scope).results, ...excludedFailResults(docs, mapped, scope)];
    assessed = assessRequirements(requirements, results, scope);
    summary = computeSummary(assessed, results, scope);
  });
  const byId = id => assessed.find(r => r.id === id);

  it('gives every requirement its status', () => {
    assert.deepEqual(assessed.map(r => [r.id, r.status]), [
      ['GV.01', 'met-findings'], ['GV.02', 'met-findings'], ['QA.01', 'no-data'], ['QA.02', 'not-met'],
      ['BR.02', 'no-data'], ['BR.06', 'not-assessed'], ['DE.01', 'met'], ['DE.02', 'optional'],
    ]);
  });

  it('counts repositories per requirement; a repository passes only if it passes every applicable check', () => {
    assert.deepEqual(byId('GV.01').repositories, { applicable: 3, passing: 1, failing: 2, not_applicable: 0, no_data: 0 });
    assert.equal(byId('GV.01').coverage, 33.3);
    assert.deepEqual(byId('GV.02').repositories, { applicable: 2, passing: 1, failing: 1, not_applicable: 0, no_data: 1 });
    assert.equal(byId('QA.01').coverage, null);
    assert.equal(byId('DE.01').coverage, 100);
    assert.equal(byId('QA.02').repositories, null);
  });

  it('is met when all repositories are not applicable', () => {
    const [r] = assessRequirements([{ id: 'X.1', level: 'SHOULD', checks: ['x'] }], [{ repo: 'a', check: 'x', result: 'na' }], { active: ['a'] });
    assert.equal(r.status, 'met');
    assert.equal(r.coverage, null);
  });

  it('summarises the checks of assessed requirements, counting each result once', () => {
    assert.deepEqual(summary, {
      checks_evaluated: 10,
      checks_passed: 7,
      compliance_pct: 70,
      requirements_by_status: { met: 1, 'met-findings': 2, 'not-met': 1, 'no-data': 2, 'not-assessed': 1, optional: 1 },
      must_met: 2,
      must_total: 5,
      failing_repositories: 2,
    });
  });

  it('has a null compliance without evaluated checks', () => {
    assert.equal(computeSummary([], [], { active: [] }).compliance_pct, null);
  });
});

describe('mergeHistory', () => {
  it('replaces the entry of the same month and sorts by month', () => {
    const merged = mergeHistory(PREVIOUS.history, { month: '2026-11', compliance_pct: 70 });
    assert.deepEqual(merged.map(e => [e.month, e.compliance_pct]), [['2026-09', 60], ['2026-10', 65], ['2026-11', 70]]);
  });

  it('starts with this run without a previous history', () => {
    assert.deepEqual(mergeHistory(undefined, { month: '2026-11' }), [{ month: '2026-11' }]);
  });
});

describe('latestDataPath', () => {
  it('picks the latest month folder with data.json of the report', () => {
    const paths = ['reports/2026-09/test-data.json', 'reports/2026-11/bsi-data.json', 'reports/2026-10/test-data.json', 'reports/2026-10/test-report.html',
      'reports/old/test-data.json', 'reports/2026-12/sub/test-data.json', 'reports/2026-12/xtest-data.json', ''];
    assert.equal(latestDataPath(paths, 'test'), 'reports/2026-10/test-data.json');
    assert.equal(latestDataPath(paths, 'bsi'), 'reports/2026-11/bsi-data.json');
    assert.equal(latestDataPath(paths, 'allianz'), null);
  });
});

describe('readPreviousReport', () => {
  it('reads data.json of the report from the latest month folder on origin/main', async () => {
    const previous = await readPreviousReport('test', { git: fakeGit({ 'reports/2026-10/test-data.json': JSON.stringify(PREVIOUS), 'reports/2026-09/test-data.json': '{}', 'reports/2026-11/bsi-data.json': '{}' }) });
    assert.deepEqual(previous, { sha: 'prevsha', path: 'reports/2026-10/test-data.json', doc: PREVIOUS });
  });

  it('is null when git fails (no origin/main)', async () => {
    const git = () => ({ revparse: async () => { throw new Error('fatal: ambiguous argument'); } });
    assert.equal(await readPreviousReport('test', { git }), null);
  });

  it('is null when main has no such file (first report)', async () => {
    assert.equal(await readPreviousReport('test', { git: fakeGit() }), null);
  });

  it('stops on a file that is not valid JSON', async () => {
    await assert.rejects(() => readPreviousReport('test', { git: fakeGit({ 'reports/2026-10/test-data.json': '{' }) }),
      err => err instanceof ScriptError && /reports\/2026-10\/test-data.json on origin\/main is not valid JSON/.test(err.message));
  });
});

// ── Notes ────────────────────────────────────────────────────────────────────

describe('parseNotes', () => {
  it('reads the bullets of both sections', () => {
    assert.deepEqual(parseNotes(NOTES), {
      key_messages: ['**Release integrity is the weakest area.** See `BR.03` and the [template](https://github.com/allianz/ospo/issues/1).'],
      needs_attention: ['**Decision: license review** (Legal, by 30 Nov 2026).'],
    });
  });

  it('accepts empty sections and the mock notes file', async () => {
    assert.deepEqual(parseNotes('## Key messages\n\n## Needs attention\n'), { key_messages: [], needs_attention: [] });
    const mock = parseNotes(await readFile(path.join(repoRoot, 'scripts/spec/mock_data/compliance_report_bsi_notes.md'), 'utf8'));
    assert.deepEqual([mock.key_messages.length, mock.needs_attention.length], [4, 3]);
  });

  const invalid = [
    ['another heading', '## Key messages\n## Other\n', /line 2: expected heading "## Needs attention"/],
    ['a third heading', `${NOTES}## More\n`, /expected heading "## \(none\)"/],
    ['text outside a list', '## Key messages\nSome text\n', /line 2: expected a "- " bullet/],
    ['a bullet before the first heading', '- early\n', /line 1: expected a "- " bullet under a heading/],
    ['a missing section', '## Key messages\n- one\n', /missing heading "## Needs attention"/],
    ['emphasis', '## Key messages\n- *maybe*\n## Needs attention\n', /line 2: unsupported Markdown in: \*maybe\*/],
  ];
  for (const [label, text, message] of invalid) {
    it(`rejects ${label}`, () => assert.throws(() => parseNotes(text), err => err instanceof NotesError && message.test(err.message)));
  }
});

describe('checkInlineMarkdown', () => {
  for (const text of ['plain text with snake_case and #142', '**bold** and `code_with_underscores`', '[link](https://example.test/a_b)']) {
    it(`accepts ${text}`, () => assert.doesNotThrow(() => checkInlineMarkdown(text)));
  }
  for (const text of ['_emphasis_', '[link](http://example.test)', '<b>html</b>', '![image](https://example.test/x.png)', 'unclosed `code']) {
    it(`rejects ${text}`, () => assert.throws(() => checkInlineMarkdown(text), NotesError));
  }
});

describe('readNotes', () => {
  it('is null without error for a missing file', async () => {
    assert.deepEqual(await readNotes(path.join(tmpDir, 'none.md')), { notes: null, error: null });
  });

  it('returns file, sha256 and sections', async () => {
    const file = path.join(tmpDir, 'notes.md');
    await writeFile(file, NOTES);
    const { notes, error } = await readNotes(file);
    assert.equal(error, null);
    assert.equal(notes.file, file);
    assert.match(notes.sha256, /^[0-9a-f]{64}$/);
    assert.equal(notes.key_messages.length, 1);
  });

  it('returns an error for an invalid file', async () => {
    const file = path.join(tmpDir, 'bad-notes.md');
    await writeFile(file, '# Title\n');
    const { notes, error } = await readNotes(file);
    assert.equal(notes, null);
    assert.match(error, /^Notes file .*bad-notes\.md is invalid: line 1: expected a "- " bullet/);
  });

  it('throws on read errors other than a missing file', async () => {
    await assert.rejects(() => readNotes(tmpDir), /EISDIR/);
  });
});

describe('unknownChecks', () => {
  it('lists mapped checks missing from the catalogue only when all inputs were read', () => {
    const mapped = new Set(['a/x', 'a/y', 'a/z']);
    assert.deepEqual(unknownChecks(mapped, { 'a/x': {} }, [{ status: 'ok' }]), ['a/y', 'a/z']);
    assert.deepEqual(unknownChecks(mapped, {}, [{ status: 'ok' }, { status: 'missing' }]), []);
  });
});

// ── run() ────────────────────────────────────────────────────────────────────

describe('run', () => {
  let notesFile;
  let configPath;
  before(async () => {
    notesFile = path.join(tmpDir, 'run-notes.md');
    await writeFile(notesFile, NOTES);
    configPath = await writeReportConfig('run.yaml', { notes: notesFile });
  });

  async function runReport(name, { argv = [], debug = false, git = fakeGit({ 'reports/2026-10/test-data.json': JSON.stringify(PREVIOUS), 'reports/2026-09/test-data.json': '{}', 'reports/2026-11/bsi-data.json': '{}' }), config: cfg } = {}) {
    const dir = await writeToolFiles(path.join(tmpDir, name));
    const reports = path.join(tmpDir, `${name}-reports`);
    const logger = createMemoryLogger({ debug });
    const code = await run({
      argv: ['--org', org, '--config', cfg ?? configPath, '--dir', dir, '--reports', reports, ...argv],
      env: { GITHUB_SHA: 'abc123', GITHUB_REPOSITORY: 'allianz/ospo', GITHUB_RUN_ID: '42' },
      logger,
      git,
      now: NOW,
    });
    const data = JSON.parse(await readFile(path.join(reports, '2026-11', 'test-data.json'), 'utf8'));
    const html = await readFile(path.join(reports, '2026-11', 'test-report.html'), 'utf8');
    return { code, logger, data, html, dir, reports };
  }

  /** data.json without the values that depend on the tmp directory. */
  const stable = (data, dir) => ({
    ...data,
    report_config: '<config>',
    config_sha256: '<sha>',
    notes: data.notes && { ...data.notes, file: '<notes>' },
    errors: data.errors.map(e => ({ ...e, reason: e.reason.replace(tmpDir, '<tmp>') })),
    inputs: data.inputs.map(i => ({ ...i, problems: i.problems?.map(p => p.replace(dir, '<dir>')) })),
  });

  it('writes data.json with statuses, summary, notes and the merged history', async t => {
    const { code, logger, data, dir } = await runReport('full');
    assert.equal(code, 0);
    assert.equal(data.report_id, 'OSPO-CR-TEST-2026-11');
    assert.deepEqual(data.previous_report, { report_id: 'OSPO-CR-TEST-2026-10', data_url: 'https://github.com/allianz/ospo/blob/prevsha/reports/2026-10/test-data.json' });
    assert.deepEqual(data.history.map(e => e.month), ['2026-09', '2026-10', '2026-11']);
    assert.deepEqual(data.history.at(-1), {
      month: '2026-11', compliance_pct: 70, failing_repositories: 2,
      coverage: { 'GV.01': 33.3, 'GV.02': 50, 'QA.01': null, 'BR.02': null, 'DE.01': 100 },
    });
    assert.equal(data.run_url, 'https://github.com/allianz/ospo/actions/runs/42');
    assert.deepEqual(Object.keys(data), [
      'report_id', 'run_at', 'org', 'ospo_sha', 'run_url', 'report_config', 'config_sha256', 'framework', 'previous_report',
      'inputs', 'scope', 'requirements', 'summary', 'notes', 'history', 'catalogue', 'results', 'skipped', 'errors',
    ]);
    t.assert.snapshot(stable(data, dir));
    t.assert.snapshot(logger.output().replace(dir, '<dir>').replaceAll(`${tmpDir}/full-reports`, '<reports>'));
  });

  it('writes the HTML report next to data.json, with exactly that data embedded', async () => {
    const { data, html, reports } = await runReport('html');
    const embedded = html.match(/<script type="application\/json" id="data.json">(.*?)<\/script>/s)[1];
    assert.deepEqual(JSON.parse(embedded), data);
    assert.ok(!html.includes(DATA_PLACEHOLDER));
    assert.match(html, /<title>Test Framework Compliance Report · test-org · 2026-11<\/title>/);
    assert.deepEqual(await readdir(path.join(reports, '2026-11')), ['test-data.json', 'test-report.html']);
  });

  it('writes into the reports folder of the repository by default', () => {
    assert.equal(DEFAULT_REPORTS_PATH, path.join(repoRoot, 'reports'));
  });

  it('is reproducible: summary and requirement counts follow from data.json alone', async () => {
    const { data } = await runReport('reproducible');
    const requirements = data.requirements.map(({ id, chapter, level, title, text, implementation, checks }) => ({ id, chapter, level, title, text, implementation, checks }));
    const assessed = assessRequirements(requirements, data.results, data.scope);
    assert.deepEqual(assessed, data.requirements);
    assert.deepEqual(computeSummary(assessed, data.results, data.scope), data.summary);
  });

  it('starts the history without a previous report', async () => {
    const { data, logger } = await runReport('first', { git: fakeGit() });
    assert.equal(data.previous_report, null);
    assert.deepEqual(data.history.map(e => e.month), ['2026-11']);
    assert.match(logger.output(), /History: 1 month \(previous report: none\)/);
  });

  it('prints the requirements with --debug', async () => {
    const { logger } = await runReport('debug', { argv: ['--debug'], debug: true });
    assert.match(logger.output(), /\n {2}GV\.02 met-findings 50% \(1\/2, na 0, no data 1\)\n/);
    assert.match(logger.output(), /\n {2}QA\.01 no-data –% \(0\/0, na 0, no data 3\)\n/);
    assert.match(logger.output(), /\n {2}QA\.02 not-met\n/);
  });

  it('reports an invalid notes file as an error and keeps notes null', async () => {
    const badNotes = path.join(tmpDir, 'run-bad-notes.md');
    await writeFile(badNotes, '## Key messages\n- <b>x</b>\n## Needs attention\n');
    const { data, logger } = await runReport('bad-notes', { config: await writeReportConfig('bad-notes.yaml', { notes: badNotes }) });
    assert.equal(data.notes, null);
    assert.deepEqual(data.errors.at(-1).tool, 'compliance_report');
    assert.match(data.errors.at(-1).reason, /is invalid: line 2: unsupported Markdown/);
    assert.match(logger.output(), /Warning: data health: 2 errors \(no data\)/);
  });

  it('has no notes without a notes entry and warns about unknown checks when all inputs are ok', async () => {
    const cfg = await writeReportConfig('no-notes.yaml', {
      inputs: INPUTS.slice(0, 1),
      requirements: { 'GV.01': { title: 't', level: 'MUST', checks: ['lint/contributing', 'lint/typo'] } },
    });
    const { data, logger } = await runReport('no-notes', { config: cfg });
    assert.equal(data.notes, null);
    assert.deepEqual(data.errors, []);
    assert.match(logger.output(), /Warning: mapped check lint\/typo is in no tool file\n/);
    assert.doesNotMatch(logger.output(), /data health/);
  });

  it('requires --config and --dir', async () => {
    await assert.rejects(() => run({ argv: ['--org', org, '--dir', tmpDir] }), err => err instanceof ScriptError && err.message === '--config is required');
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath] }), err => err instanceof ScriptError && err.message === '--dir is required');
  });
});

describe('buildData', () => {
  it('builds data.json without previous report, notes or inputs', async () => {
    const data = buildData({
      config: await config(),
      configFile: 'config/x.yaml',
      configSha: 's',
      inputs: [],
      docs: [],
      previous: null,
      notes: null,
      notesError: null,
      header: { run_at: '2026-12-01T00:00:00Z', org, ospo_sha: null, run_url: null },
    });
    assert.equal(data.report_id, 'OSPO-CR-TEST-2026-12');
    assert.deepEqual(data.scope, { active: [], archived: [] });
    assert.equal(data.summary.compliance_pct, null);
    assert.deepEqual(STATUSES.map(s => data.summary.requirements_by_status[s]), [0, 0, 1, 5, 1, 1]);
  });
});

// ── The BSI report configuration ─────────────────────────────────────────────

describe('config/compliance_report_bsi.yaml', () => {
  const configFile = path.join(repoRoot, 'config/compliance_report_bsi.yaml');

  it('maps only checks that the tools define', async () => {
    const lint = lintCatalogue(await loadLintConfig(path.join(repoRoot, 'config/lint_repos.yaml')));
    const scorecard = await loadScorecardConfig(path.join(repoRoot, 'config/scorecard_check.yaml'));
    const known = new Set([
      ...Object.keys(lint),
      ...Object.keys(licenseCatalogue()),
      ...Object.keys(archiveCatalogue({ warnAfter: '1 years', gracePeriod: '60 days' })),
      ...Object.keys(BY_CONSTRUCTION_CHECKS),
      ADVISORIES_CHECK,
      VERSIONING,
      RELEASE_NOTES,
      ...Object.keys(scorecard.thresholds).map(checkId),
    ]);
    const { requirements } = await loadReportConfig(configFile);
    assert.deepEqual([...mappedChecks(requirements)].filter(check => !known.has(check)), []);
    assert.equal(requirements.length, 20);
  });

  it('names existing scripts and a valid notes file', async () => {
    const reportConfig = await loadReportConfig(configFile);
    for (const input of reportConfig.inputs) await readFile(path.join(repoRoot, input.script));
    const { error } = await readNotes(reportConfig.notes);
    assert.equal(error, null);
  });
});
