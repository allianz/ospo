import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScriptError } from '../lib/cli.js';
import { repoRoot } from '../lib/config.js';
import {
  LANGUAGES_NOT_READABLE, NO_CHECKS, SOURCE, TOOL,
  applicabilityNotes, buildCatalogue, buildJsonResults, checkId, convertChecks, countChangesets,
  createScorecardCli, fuzzingApplicability, loadConfig, loadManagedRepos, parseOutput, repositoryEntry, run,
} from '../scorecard_check.js';
import { createFakeGitHub, notFound } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const NOW = new Date('2026-11-03T02:00:00Z');
const VERSION = { version: 'v5.6.0', commit: '61e84743356275f6ffca23b1b2f2cb945e19eb96' };
const FUZZING = { languages: ['C', 'C++', 'Objective-C', 'Objective-C++', 'Assembly'], min_share: 5 };
const NOT_FUZZED = { applies: false, line: 'Info: scorecard_check: not applicable, no non-memory-safe language (C) above 5%' };

/** Real, unmodified Scorecard CLI output (allianz/yukimi, v5.6.0). */
const fixture = JSON.parse(await readFile(path.join(repoRoot, 'scripts/test/fixtures/scorecard_cli_real_yukimi.json'), 'utf8'));
const ALL_THRESHOLDS = Object.fromEntries(fixture.checks.map(c => [c.name, 8]));

/** The fixture with some checks changed: `{ 'CI-Tests': { score: -1, reason: '…' } }`; `null` removes a check. */
function scorecardOutput(changes = {}, { repo = 'yukimi' } = {}) {
  const output = structuredClone(fixture);
  output.repo.name = `github.com/allianz/${repo}`;
  output.checks = output.checks
    .filter(c => changes[c.name] !== null)
    .map(c => (changes[c.name] ? { ...c, ...changes[c.name] } : c));
  return output;
}

const byCheck = (results, name) => results.find(r => r.check === checkId(name));

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'scorecard-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

async function writeFileIn(name, lines) {
  const file = path.join(tmpDir, name);
  await writeFile(file, lines.join('\n'));
  return file;
}

// ── Config ───────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  const minimal = ['scorecard_version: v5.6.0', 'thresholds:', '  CI-Tests: 8'];

  it('fills in the defaults', async () => {
    const config = await loadConfig(await writeFileIn('minimal.yaml', minimal));
    assert.deepEqual(config, {
      concurrency: 3,
      create_repos_config: 'config/create_repos.yaml',
      not_applicable_topics: ['docs', 'template'],
      fuzzing: FUZZING,
      scorecard_version: 'v5.6.0',
      thresholds: { 'CI-Tests': 8 },
      excluded_repos: [],
    });
  });

  it('merges a partial fuzzing section with the defaults', async () => {
    const config = await loadConfig(await writeFileIn('fuzzing.yaml', [...minimal, 'fuzzing:', '  min_share: 10']));
    assert.deepEqual(config.fuzzing, { ...FUZZING, min_share: 10 });
  });

  it('loads the production config, which configures exactly the checks of Scorecard v5.6.0', async () => {
    const config = await loadConfig(path.join(repoRoot, 'config/report/scorecard_check.yaml'));
    assert.equal(config.scorecard_version, fixture.scorecard.version);
    assert.deepEqual(Object.keys(config.thresholds).sort(), fixture.checks.map(c => c.name).sort());
  });

  it('loads the test config', async () => {
    const config = await loadConfig(path.join(repoRoot, 'scripts/test-config/report/scorecard_check.yaml'));
    assert.equal(config.create_repos_config, 'scripts/test-config/create_repos.yaml');
  });

  const invalid = [
    ['an empty file', ['# nothing'], /missing required field: scorecard_version/],
    ['no thresholds', ['scorecard_version: v5.6.0'], /missing required field: thresholds/],
    ['empty thresholds', ['scorecard_version: v5.6.0', 'thresholds: {}'], /missing required field: thresholds/],
    ['a threshold above 10', ['scorecard_version: v5.6.0', 'thresholds:', '  CI-Tests: 11'], /Threshold of CI-Tests must be an integer from 0 to 10/],
    ['a non-integer threshold', ['scorecard_version: v5.6.0', 'thresholds:', '  CI-Tests: high'], /Threshold of CI-Tests/],
    ['concurrency 0', [...minimal, 'concurrency: 0'], /concurrency must be a positive integer/],
    ['an empty create_repos_config', [...minimal, 'create_repos_config: ""'], /create_repos_config must be a file path/],
    ['topics that are not a list', [...minimal, 'not_applicable_topics: docs'], /not_applicable_topics must be a list/],
    ['languages that are not a list', [...minimal, 'fuzzing:', '  languages: C'], /fuzzing.languages must be a list/],
    ['min_share above 100', [...minimal, 'fuzzing:', '  min_share: 101'], /fuzzing.min_share must be a number from 0 to 100/],
  ];
  for (const [i, [label, lines, message]] of invalid.entries()) {
    it(`rejects ${label}`, async () => {
      const file = await writeFileIn(`invalid-${i}.yaml`, lines);
      await assert.rejects(() => loadConfig(file), message);
    });
  }
});

describe('loadManagedRepos', () => {
  it('returns the repos with branch-protection managed (the default)', async () => {
    const file = await writeFileIn('create_repos.yaml', [
      'repositories:',
      '  - name: "a"',
      '  - name: "b"',
      '    branch-protection: custom',
      '  - name: "c"',
      '    branch-protection: managed',
    ]);
    assert.deepEqual([...await loadManagedRepos(file)].sort(), ['a', 'c']);
  });
});

// ── Applicability ────────────────────────────────────────────────────────────

describe('fuzzingApplicability', () => {
  it('applies when a listed language has more than min_share, listing all found', () => {
    assert.deepEqual(fuzzingApplicability({ Swift: 700, 'Objective-C': 260, C: 30, Shell: 10 }, FUZZING), {
      applies: true,
      line: 'Info: scorecard_check: applies, Objective-C 26%, C 3%',
    });
  });

  it('does not apply to memory-safe languages only', () => {
    assert.deepEqual(fuzzingApplicability({ Go: 1000 }, FUZZING), {
      applies: false,
      line: 'Info: scorecard_check: not applicable, no non-memory-safe language (C, C++, Objective-C, Objective-C++, Assembly) above 5%',
    });
  });

  it('does not apply at exactly min_share and names the languages below it', () => {
    const { applies, line } = fuzzingApplicability({ Go: 950, C: 50 }, FUZZING);
    assert.equal(applies, false);
    assert.match(line, /above 5% \(C 5%\)$/);
  });

  it('does not apply to a repository without code', () => {
    assert.equal(fuzzingApplicability({}, FUZZING).applies, false);
  });
});

describe('countChangesets', () => {
  const cases = [
    ['a missing Code-Review', undefined, { error: 'Code-Review not in Scorecard output' }],
    ['an internal error', { score: -1, reason: 'internal error: boom' }, { error: 'Code-Review failed: internal error: boom' }],
    ['an inconclusive Code-Review', { score: -1, reason: 'no commits found' }, { count: 0 }],
    ['approved changesets', { score: 4, reason: 'Found 12/30 approved changesets -- score normalized to 4' }, { count: 30 }],
    ['all changesets reviewed', { score: 10, reason: 'all changesets reviewed' }, { count: 0 }],
    ['no changesets found', { score: 0, reason: 'no changesets found' }, { count: 0 }],
    ['no changesets detected', { score: 0, reason: 'no changesets detected' }, { count: 0 }],
    ['an unknown wording', { score: 3, reason: 'something new' }, { error: 'unrecognised Code-Review reason: "something new"' }],
    ['no reason', { score: 3 }, { error: 'unrecognised Code-Review reason: ""' }],
  ];
  for (const [label, codeReview, expected] of cases) {
    it(`handles ${label}`, () => assert.deepEqual(countChangesets(codeReview), expected));
  }
});

// ── Conversion ───────────────────────────────────────────────────────────────

describe('convertChecks', () => {
  const convert = (output, context = {}) => convertChecks(output, { thresholds: ALL_THRESHOLDS, fuzzing: NOT_FUZZED, ...context });

  it('writes every configured check in config order, copying score, reason and details', () => {
    const { results, errors, ignored } = convert(fixture);
    assert.deepEqual(results.map(r => r.check), fixture.checks.map(c => checkId(c.name)));
    assert.deepEqual(errors, []);
    assert.deepEqual(ignored, []);
    assert.deepEqual(byCheck(results, 'Token-Permissions'), {
      check: 'scorecard/token-permissions',
      name: 'Token-Permissions',
      score: 10,
      reason: 'GitHub workflow tokens follow principle of least privilege',
      details: fixture.checks.find(c => c.name === 'Token-Permissions').details,
      result: 'pass',
    });
  });

  it('compares the score with the threshold and turns null details into []', () => {
    const { results } = convert(fixture);
    assert.deepEqual(byCheck(results, 'Contributors'), {
      check: 'scorecard/contributors', name: 'Contributors', score: 6,
      reason: 'project has 2 contributing companies or organizations -- score normalized to 6',
      details: ['Info: found contributions from: allianz, ospo-sandbox'], result: 'fail',
    });
    assert.equal(byCheck(results, 'Vulnerabilities').result, 'pass');
    assert.deepEqual(byCheck(results, 'CI-Tests').details, []);
  });

  it('turns other inconclusive results (-1) into na with score null', () => {
    const { results } = convert(fixture);
    assert.deepEqual([byCheck(results, 'Packaging'), byCheck(results, 'Signed-Releases')].map(r => [r.result, r.score]), [['na', null], ['na', null]]);
  });

  it('applies Branch-Protection only to repos without managed branch protection', () => {
    assert.equal(byCheck(convert(fixture).results, 'Branch-Protection').result, 'fail');
    const managed = byCheck(convert(fixture, { managed: true }).results, 'Branch-Protection');
    assert.equal(managed.result, 'na');
    assert.equal(managed.score, 5);
    assert.equal(managed.reason, 'branch protection is not maximal on development and all release branches');
    assert.equal(managed.details[0], 'Info: scorecard_check: not evaluated, branch-protection is managed by the org ruleset ospo-managed');
    assert.equal(managed.details.length, 10);
  });

  it('makes CI-Tests na for a not-applicable topic', () => {
    const r = byCheck(convert(fixture, { topics: ['java', 'docs'], naTopics: ['docs', 'template'] }).results, 'CI-Tests');
    assert.deepEqual([r.result, r.score, r.details], ['na', 10, ["Info: scorecard_check: not applicable, topic 'docs'"]]);
  });

  it('fails an inconclusive CI-Tests when Code-Review counted changesets (changes without pull requests)', () => {
    const output = scorecardOutput({
      'CI-Tests': { score: -1, reason: 'no pull request found' },
      'Code-Review': { score: 0, reason: 'Found 0/30 approved changesets -- score normalized to 0' },
    });
    assert.deepEqual(byCheck(convert(output).results, 'CI-Tests'), {
      check: 'scorecard/ci-tests', name: 'CI-Tests', score: null, reason: 'no pull request found',
      details: ['Warn: scorecard_check: 30 changesets reached the default branch without pull requests'], result: 'fail',
    });
  });

  it('keeps an inconclusive CI-Tests na without changesets', () => {
    const output = scorecardOutput({ 'CI-Tests': { score: -1, reason: 'no pull request found' }, 'Code-Review': { score: -1, reason: 'no commits found' } });
    const r = byCheck(convert(output).results, 'CI-Tests');
    assert.deepEqual([r.result, r.score, r.details], ['na', null, []]);
  });

  it('puts an inconclusive CI-Tests into errors when the Code-Review wording is unknown', () => {
    const output = scorecardOutput({ 'CI-Tests': { score: -1, reason: 'no pull request found' }, 'Code-Review': { reason: 'reviewed somehow' } });
    const { results, errors } = convert(output);
    assert.equal(byCheck(results, 'CI-Tests'), undefined);
    assert.deepEqual(errors, [{ check: 'scorecard/ci-tests', reason: 'unrecognised Code-Review reason: "reviewed somehow"' }]);
  });

  it('puts internal errors and missing checks into errors, never na', () => {
    const output = scorecardOutput({ SAST: { score: -1, reason: 'internal error: GraphQL timeout' }, License: null });
    const { results, errors } = convert(output);
    assert.equal(results.length, fixture.checks.length - 2);
    assert.deepEqual(errors, [
      { check: 'scorecard/license', reason: 'License not in Scorecard output' },
      { check: 'scorecard/sast', reason: 'internal error: GraphQL timeout' },
    ]);
  });

  it('decides managed branch protection before an internal error', () => {
    const output = scorecardOutput({ 'Branch-Protection': { score: -1, reason: 'internal error: no admin token' } });
    assert.equal(byCheck(convert(output, { managed: true }).results, 'Branch-Protection').result, 'na');
  });

  it('applies the Fuzzing threshold only where it applies, with the languages as first details line', () => {
    const output = scorecardOutput({ Fuzzing: { score: 0, reason: 'project is not fuzzed', details: null } });
    const notApplicable = byCheck(convert(output).results, 'Fuzzing');
    assert.deepEqual([notApplicable.result, notApplicable.score, notApplicable.details], ['na', 0, [NOT_FUZZED.line]]);
    const applies = byCheck(convert(output, { fuzzing: { applies: true, line: 'Info: scorecard_check: applies, C 40%' } }).results, 'Fuzzing');
    assert.deepEqual([applies.result, applies.details], ['fail', ['Info: scorecard_check: applies, C 40%']]);
  });

  it('records Fuzzing in errors when the languages could not be read', () => {
    const { errors } = convert(fixture, { fuzzing: { error: LANGUAGES_NOT_READABLE } });
    assert.deepEqual(errors, [{ check: 'scorecard/fuzzing', reason: LANGUAGES_NOT_READABLE }]);
  });

  it('ignores checks that are not configured', () => {
    const { results, ignored } = convertChecks(fixture, { thresholds: { License: 10 }, fuzzing: NOT_FUZZED });
    assert.deepEqual(results.map(r => r.check), ['scorecard/license']);
    assert.equal(ignored.length, fixture.checks.length - 1);
    assert.ok(ignored.includes('Webhooks') === false && ignored.includes('SAST'));
  });
});

describe('repositoryEntry', () => {
  it('records the scanned commit, the date in UTC and the overall score', () => {
    assert.deepEqual(repositoryEntry('yukimi', fixture), {
      repo: 'yukimi', commit: 'fac40d6d8ec407a1f09295782502ae6f0bc2ea80', date: '2026-11-04T07:57:08Z', score: 9.1,
    });
  });

  it('uses null for missing or invalid fields', () => {
    assert.deepEqual(repositoryEntry('x', { checks: [], date: 'yesterday' }), { repo: 'x', commit: null, date: null, score: null });
  });
});

// ── JSON output ──────────────────────────────────────────────────────────────

describe('buildCatalogue', () => {
  const notes = applicabilityNotes({ naTopics: ['docs', 'template'], fuzzing: FUZZING });

  it('copies Scorecard documentation, adds the threshold and appends the applicability notes', () => {
    const catalogue = buildCatalogue({ thresholds: { Fuzzing: 10, License: 10 }, outputs: [fixture], scorecardCommit: VERSION.commit, notes });
    assert.deepEqual(catalogue, {
      'scorecard/fuzzing': {
        name: 'Fuzzing',
        threshold: 10,
        documentation: {
          url: `https://github.com/ossf/scorecard/blob/${VERSION.commit}/docs/checks.md#fuzzing`,
          short: 'Determines if the project uses fuzzing. Applies only to repositories with more than 5% code in a non-memory-safe language (C, C++, Objective-C, Objective-C++, Assembly); all others are not applicable.',
        },
      },
      'scorecard/license': {
        name: 'License',
        threshold: 10,
        documentation: {
          url: `https://github.com/ossf/scorecard/blob/${VERSION.commit}/docs/checks.md#license`,
          short: 'Determines if the project has defined a license.',
        },
      },
    });
  });

  it('notes the topics for CI-Tests and the ruleset for Branch-Protection', () => {
    const catalogue = buildCatalogue({ thresholds: { 'CI-Tests': 8, 'Branch-Protection': 6 }, outputs: [fixture], scorecardCommit: VERSION.commit, notes });
    assert.match(catalogue['scorecard/ci-tests'].documentation.short, /topic docs or template\. Inconclusive \(-1\)/);
    assert.match(catalogue['scorecard/branch-protection'].documentation.short, /org ruleset ospo-managed\.$/);
  });

  it('links to the docs of the Scorecard commit for a check no output had', () => {
    assert.deepEqual(buildCatalogue({ thresholds: { Webhooks: 10 }, outputs: [fixture], scorecardCommit: VERSION.commit })['scorecard/webhooks'].documentation, {
      url: `https://github.com/ossf/scorecard/blob/${VERSION.commit}/docs/checks.md#webhooks`,
      short: 'Scorecard check Webhooks.',
    });
    assert.match(buildCatalogue({ thresholds: { Webhooks: 10 }, outputs: [] })['scorecard/webhooks'].documentation.url, /blob\/main\//);
  });
});

describe('buildJsonResults', () => {
  it('sorts by repo, adds the score, and gives an unscanned repo one error per check', () => {
    const thresholds = { License: 10, SAST: 7 };
    const catalogue = buildCatalogue({ thresholds, outputs: [fixture] });
    const { results, skipped, errors } = buildJsonResults({
      evaluated: [
        { repo: 'z', ...convertChecks(fixture, { thresholds, fuzzing: NOT_FUZZED }) },
        { repo: 'm', error: 'Scorecard failed (exit code 1)' },
        { repo: 'a', results: [], errors: [{ check: 'scorecard/sast', reason: 'internal error: x' }] },
      ],
      archived: [{ name: 'old' }],
      excluded: [{ name: 'legacy' }],
      catalogue,
      thresholds,
    });
    assert.deepEqual(results, [
      { repo: 'z', check: 'scorecard/license', name: 'License', result: 'pass', score: 10, reason: 'license file detected', details: fixture.checks.find(c => c.name === 'License').details },
      { repo: 'z', check: 'scorecard/sast', name: 'SAST', result: 'pass', score: 10, reason: 'SAST tool is run on all commits', details: ['Info: all commits (30) are checked with a SAST tool'] },
    ]);
    assert.deepEqual(skipped, [{ repo: 'old', reason: 'archived' }, { repo: 'legacy', reason: 'excluded_repos' }]);
    assert.deepEqual(errors, [
      { repo: 'a', check: 'scorecard/sast', reason: 'internal error: x' },
      { repo: 'm', check: 'scorecard/license', reason: 'Scorecard failed (exit code 1)' },
      { repo: 'm', check: 'scorecard/sast', reason: 'Scorecard failed (exit code 1)' },
    ]);
  });
});

// ── Scorecard CLI ────────────────────────────────────────────────────────────

describe('parseOutput', () => {
  it('returns the output only if it is JSON with a checks list', () => {
    assert.deepEqual(parseOutput(JSON.stringify(fixture)), fixture);
    assert.equal(parseOutput('{"checks": null}'), null);
    assert.equal(parseOutput('null'), null);
    assert.equal(parseOutput('Starting [Fuzzing]'), null);
  });
});

describe('createScorecardCli', () => {
  /** A fake promisified execFile: `respond(args)` returns { stdout, stderr } or throws. */
  function fakeExec(respond) {
    const calls = [];
    const execFile = async (bin, args, options) => {
      calls.push({ bin, args, options });
      return respond(args);
    };
    return { calls, execFile };
  }
  const exitError = (code, { stdout = '', stderr = '', killed = false } = {}) =>
    Object.assign(new Error(`Command failed with code ${code}`), { code, stdout, stderr, killed });

  it('reads version and commit from "scorecard version"', async () => {
    const { calls, execFile } = fakeExec(() => ({ stdout: '', stderr: ' ___ \nGitVersion:    v5.6.0\nGitCommit:     61e8474\nGoVersion: go1.27\n' }));
    const cli = createScorecardCli({ bin: '/bin/sc', env: { A: '1' }, execFile });
    assert.deepEqual(await cli.version(), { version: 'v5.6.0', commit: '61e8474' });
    assert.deepEqual(calls.map(c => [c.bin, c.args, c.options.env]), [['/bin/sc', ['version'], { A: '1' }]]);
  });

  it('accepts a version without commit', async () => {
    const { execFile } = fakeExec(() => ({ stdout: 'GitVersion: v5.6.0\n', stderr: '' }));
    assert.deepEqual(await createScorecardCli({ execFile }).version(), { version: 'v5.6.0', commit: null });
  });

  it('fails with a ScriptError when the version cannot be read', async () => {
    const { execFile } = fakeExec(() => { throw exitError(2, { stderr: 'unknown command' }); });
    await assert.rejects(() => createScorecardCli({ execFile }).version(), err =>
      err instanceof ScriptError && /Could not read the Scorecard version from "scorecard version": Command failed/.test(err.message));
    const { execFile: silent } = fakeExec(() => ({ stdout: 'hello', stderr: '' }));
    await assert.rejects(() => createScorecardCli({ execFile: silent }).version(), /Could not read the Scorecard version from "scorecard version"$/);
  });

  it('fails with a ScriptError when the binary is missing', async () => {
    const { execFile } = fakeExec(() => { throw Object.assign(new Error('spawn scorecard ENOENT'), { code: 'ENOENT' }); });
    const cli = createScorecardCli({ execFile });
    await assert.rejects(() => cli.version(), err => err instanceof ScriptError && /Scorecard CLI not found: scorecard/.test(err.message));
    await assert.rejects(() => cli.scan(org, 'r'), ScriptError);
  });

  it('scans one repository with JSON output and details', async () => {
    const { calls, execFile } = fakeExec(() => ({ stdout: JSON.stringify(fixture), stderr: '' }));
    const output = await createScorecardCli({ execFile, env: { GITHUB_AUTH_TOKEN: 't' } }).scan(org, 'yukimi');
    assert.deepEqual(output, fixture);
    assert.deepEqual(calls[0].args, ['--repo=github.com/test-org/yukimi', '--format=json', '--show-details']);
    assert.equal(calls[0].options.env.GITHUB_AUTH_TOKEN, 't');
    assert.ok(calls[0].options.timeout > 0 && calls[0].options.maxBuffer > 0);
  });

  it('uses the JSON of a run that exits non-zero', async () => {
    const { execFile } = fakeExec(() => { throw exitError(1, { stdout: JSON.stringify(fixture), stderr: 'check SAST failed' }); });
    assert.deepEqual(await createScorecardCli({ execFile }).scan(org, 'yukimi'), fixture);
  });

  it('throws a plain error without usable output', async () => {
    const cases = [
      [() => { throw exitError(1, { stderr: 'starting\nGET https://api.github.com/repos/o/r: 404 Not Found\n' }); }, 'Scorecard failed (exit code 1): GET https://api.github.com/repos/o/r: 404 Not Found'],
      [() => { throw exitError(null, { killed: true }); }, 'Scorecard failed (timeout)'],
      [() => { throw exitError(1, { stdout: undefined, stderr: undefined }); }, 'Scorecard failed (exit code 1)'],
      [() => ({ stdout: 'not json', stderr: '' }), 'Scorecard output is not valid JSON'],
      [() => ({ stdout: '{"repo":{"commit":"HEAD"},"score":-1.0,"checks":null}', stderr: '' }), NO_CHECKS],
    ];
    for (const [respond, message] of cases) {
      const { execFile } = fakeExec(respond);
      await assert.rejects(() => createScorecardCli({ execFile }).scan(org, 'r'), err => !(err instanceof ScriptError) && err.message === message);
    }
  });
});

// ── run() ────────────────────────────────────────────────────────────────────

describe('run', () => {
  const repos = [
    { name: 'pricing-engine', topics: ['java'] },
    { name: 'design-guidelines', topics: ['docs'] },
    { name: 'mobile-sdk-ios' },
    { name: 'broken' },
    { name: 'old', archived: true },
    { name: 'legacy' },
  ];
  const languages = {
    'pricing-engine': { Java: 9000 },
    'design-guidelines': { HTML: 500 },
    'mobile-sdk-ios': { Swift: 700, 'Objective-C': 260, C: 30, Shell: 10 },
  };
  const outputs = {
    'pricing-engine': scorecardOutput({}, { repo: 'pricing-engine' }),
    'design-guidelines': scorecardOutput({ 'CI-Tests': { score: -1, reason: 'no pull request found' } }, { repo: 'design-guidelines' }),
    'mobile-sdk-ios': scorecardOutput({
      Fuzzing: { score: 0, reason: 'project is not fuzzed', details: null },
      'Code-Review': { score: 9, reason: 'Found 27/30 approved changesets -- score normalized to 9' },
      SAST: { score: -1, reason: 'internal error: GraphQL timeout' },
    }, { repo: 'mobile-sdk-ios' }),
  };
  const thresholds = ['Branch-Protection: 6', 'CI-Tests: 8', 'Code-Review: 7', 'Fuzzing: 10', 'SAST: 7', 'Security-Policy: 10'];

  /** A fake Scorecard CLI; repos without an output fail to scan. */
  function fakeScorecard({ version = VERSION, scan } = {}) {
    const scanned = [];
    return {
      scanned,
      version: async () => version,
      scan: scan ?? (async (o, repo) => {
        scanned.push(repo);
        if (!outputs[repo]) throw new Error('Scorecard failed (exit code 1): repo is empty');
        return structuredClone(outputs[repo]);
      }),
    };
  }

  let configPath;
  before(async () => {
    const createRepos = await writeFileIn('run_create_repos.yaml', [
      'repositories:',
      '  - name: "pricing-engine"',
      '  - name: "design-guidelines"',
      '  - name: "broken"',
    ]);
    configPath = await writeFileIn('scorecard_check.yaml', [
      'excluded_repos: [legacy]',
      'scorecard_version: v5.6.0',
      `create_repos_config: ${createRepos}`,
      'thresholds:',
      ...thresholds.map(t => `  ${t}`),
    ]);
  });

  async function runCheck(argv, { debug = false, env, fakeOptions = {}, scorecard = fakeScorecard() } = {}) {
    const gh = createFakeGitHub({ repos, languages, ...fakeOptions });
    const logger = createMemoryLogger({ debug });
    const code = await run({ argv: ['--org', org, '--config', configPath, ...argv], github: gh, scorecard, logger, env, now: NOW });
    return { gh, logger, code, scorecard };
  }

  it('logs findings and writes nothing to GitHub', async t => {
    const { gh, logger, code, scorecard } = await runCheck(['--json', path.join(tmpDir, 'out', 'log.json')]);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    assert.deepEqual(scorecard.scanned.sort(), ['broken', 'design-guidelines', 'mobile-sdk-ios', 'pricing-engine']);
    assert.deepEqual(gh.callsTo('listLanguages').map(c => c.args[1]).sort(), ['design-guidelines', 'mobile-sdk-ios', 'pricing-engine']);
    t.assert.snapshot(logger.output().replace(tmpDir, '<tmp>'));
  });

  it('--debug also lists passing and not applicable checks', async () => {
    const { logger } = await runCheck(['--debug', '--json', path.join(tmpDir, 'out', 'debug.json')], { debug: true });
    const out = logger.output();
    assert.match(out, /Managed branch protection: 3 repositories \(from .*run_create_repos\.yaml\)\n/);
    assert.match(out, / {2}pricing-engine: Security-Policy 10: security policy file detected\n/);
    assert.match(out, / {2}design-guidelines: CI-Tests na: not applicable, topic 'docs'\n/);
    assert.match(out, / {2}pricing-engine: Branch-Protection na: not evaluated, branch-protection is managed by the org ruleset ospo-managed\n/);
  });

  it('reports progress as each scan finishes, then an empty line before the results', async () => {
    const delays = { 'pricing-engine': 0, 'design-guidelines': 30, 'mobile-sdk-ios': 10 };
    const scorecard = fakeScorecard({
      scan: async (o, repo) => {
        await new Promise(resolve => setTimeout(resolve, delays[repo]));
        return { ...structuredClone(outputs['pricing-engine']), score: repo === 'mobile-sdk-ios' ? undefined : 7.5 };
      },
    });
    const { logger } = await runCheck(['--json', path.join(tmpDir, 'out', 'progress.json')], {
      scorecard,
      fakeOptions: { repos: repos.filter(r => r.name in delays) },
    });
    assert.match(logger.output(), new RegExp([
      'Scanning 3 repositories \\(3 at a time\\)\\.\\.\\.',
      '  \\[1/3\\] pricing-engine: score 7\\.5',
      '  \\[2/3\\] mobile-sdk-ios: score n/a',
      '  \\[3/3\\] design-guidelines: score 7\\.5',
      '',
      '',
    ].join('\n')));
  });

  it('says so when nothing fails', async () => {
    const scorecard = fakeScorecard({ scan: async () => structuredClone(outputs['pricing-engine']) });
    const { logger } = await runCheck(['--json', path.join(tmpDir, 'out', 'ok.json')], {
      scorecard,
      fakeOptions: { repos: [{ name: 'pricing-engine' }], languages: { 'pricing-engine': { Go: 10 } } },
    });
    assert.match(logger.output(), /\nScanned repositories: 1\nNo findings\.\n\nJSON/);
    assert.doesNotMatch(logger.output(), /Errors:/);
  });

  it('writes all configured checks, the Scorecard version and the repositories block as JSON', async t => {
    const file = path.join(tmpDir, 'out', 'scorecard.json');
    const { logger } = await runCheck(['--json', file], { env: { GITHUB_SHA: 'abc123' } });
    assert.match(logger.output(), /\nJSON written to .*scorecard\.json\n$/);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.tool, TOOL);
    assert.equal(doc.issue_title, null);
    assert.equal(doc.source, SOURCE);
    assert.equal(doc.scorecard_version, 'v5.6.0');
    assert.equal(doc.scorecard_commit, VERSION.commit);
    assert.deepEqual(doc.results.filter(r => r.result === 'fail').map(r => [r.repo, r.check]), [
      ['mobile-sdk-ios', 'scorecard/branch-protection'],
      ['mobile-sdk-ios', 'scorecard/fuzzing'],
    ]);
    assert.deepEqual(doc.repositories.map(r => r.repo), ['design-guidelines', 'mobile-sdk-ios', 'pricing-engine']);
    assert.ok(doc.results.every(r => r.check in doc.catalogue));
    assert.ok(doc.results.every(r => typeof r.reason === 'string' && Array.isArray(r.details)));
    t.assert.snapshot({ ...doc, config_file: '<config>', config_sha256: '<sha256>' });
  });

  it('records Fuzzing in errors when the languages return 404', async () => {
    const file = path.join(tmpDir, 'out', 'languages.json');
    const failures = { listLanguages: (o, repo) => repo === 'pricing-engine' && notFound() };
    await runCheck(['--json', file], { fakeOptions: { failures } });
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(doc.errors.filter(e => e.repo === 'pricing-engine'), [{ repo: 'pricing-engine', check: 'scorecard/fuzzing', reason: LANGUAGES_NOT_READABLE }]);
  });

  it('aborts on any other API error and writes no file', async () => {
    const file = path.join(tmpDir, 'out', 'failed.json');
    const failures = { listLanguages: (o, repo) => repo === 'mobile-sdk-ios' && Object.assign(new Error('boom'), { status: 500 }) };
    await assert.rejects(() => runCheck(['--json', file], { fakeOptions: { failures } }), /boom/);
    await assert.rejects(() => access(file));
  });

  it('aborts when the Scorecard CLI is missing', async () => {
    const scorecard = fakeScorecard({ scan: async () => { throw new ScriptError('Scorecard CLI not found: scorecard'); } });
    await assert.rejects(() => runCheck(['--json', path.join(tmpDir, 'out', 'missing.json')], { scorecard }), /Scorecard CLI not found/);
  });

  it('aborts before scanning when the Scorecard version is not the pinned one', async () => {
    const scorecard = fakeScorecard({ version: { version: 'v5.7.0', commit: null } });
    await assert.rejects(() => runCheck(['--json', path.join(tmpDir, 'out', 'version.json')], { scorecard }),
      err => err instanceof ScriptError && err.message === 'Scorecard v5.7.0 found, but scorecard_check.yaml pins v5.6.0');
    assert.deepEqual(scorecard.scanned, []);
  });

  it('logs the version without commit when the CLI reports none', async () => {
    const scorecard = fakeScorecard({ version: { version: 'v5.6.0', commit: null } });
    const { logger } = await runCheck(['--json', path.join(tmpDir, 'out', 'no-commit.json')], { scorecard });
    assert.match(logger.output(), /\nScorecard v5\.6\.0\n/);
  });

  it('requires --json and makes no call without it', async () => {
    const gh = createFakeGitHub({ repos });
    const scorecard = fakeScorecard();
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath], github: gh, scorecard }), /--json is required/);
    assert.deepEqual(gh.calls, []);
    assert.deepEqual(scorecard.scanned, []);
  });

  it('requires a token without an injected GitHub and Scorecard', async () => {
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath, '--json', 'x.json'], env: {} }), /GITHUB_TOKEN/);
    const gh = createFakeGitHub({ repos });
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath, '--json', 'x.json'], github: gh, env: {} }), /GITHUB_TOKEN/);
  });

  it('uses SCORECARD_BIN and passes the token to the CLI', async () => {
    const gh = createFakeGitHub({ repos });
    const env = { GITHUB_TOKEN: 't', SCORECARD_BIN: path.join(tmpDir, 'no-such-scorecard') };
    await assert.rejects(() => run({ argv: ['--org', org, '--config', configPath, '--json', 'x.json'], github: gh, env }),
      err => err instanceof ScriptError && err.message.includes('no-such-scorecard'));
  });
});
