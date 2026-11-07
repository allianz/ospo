#!/usr/bin/env node

// Runs the OpenSSF Scorecard CLI for every repository and writes all its checks, converted to the
// common format, with thresholds and applicability applied. JSON only: no issues, no writes to GitHub.
// See spec/scorecard_check_spec.md.

import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadConfig as loadCreateReposConfig } from './create_repos.js';
import { ScriptError, parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { defaultConfigPath, loadYaml, repoRoot } from './lib/config.js';
import { createGitHub, createOctokit, isNotFound } from './lib/github.js';
import { buildHeader, buildJsonDocument, checkResult, headingSlug, skippedRepos, writeJsonReport } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';
import { byName, partitionRepos } from './lib/repos.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const TOOL = 'scorecard_check';
export const SOURCE = 'scorecard CLI (--format=json --show-details)';
const SCORECARD_REPO = 'https://github.com/ossf/scorecard';
const MANAGED_RULESET = 'ospo-managed';
const SCAN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;
export const DEFAULTS = {
  concurrency: 3,
  create_repos_config: 'config/create_repos.yaml',
  not_applicable_topics: ['docs', 'template'],
  fuzzing: { languages: ['C', 'C++', 'Objective-C', 'Objective-C++', 'Assembly'], min_share: 5 },
};

export const BRANCH_PROTECTION = 'Branch-Protection';
export const CI_TESTS = 'CI-Tests';
export const CODE_REVIEW = 'Code-Review';
export const FUZZING = 'Fuzzing';

export const LANGUAGES_NOT_READABLE = 'Languages not readable (request returned 404: private repository or missing permission)';

/** Check ID of a Scorecard check: "CI-Tests" → "scorecard/ci-tests". */
export const checkId = name => `scorecard/${name.toLowerCase()}`;

const plural = (n, singular, pluralForm = `${singular}s`) => `${n} ${n === 1 ? singular : pluralForm}`;
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringList = value => Array.isArray(value) && value.every(v => typeof v === 'string');

// ── Config ───────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const raw = (await loadYaml(configPath)) ?? {};
  const config = { ...DEFAULTS, ...raw, fuzzing: { ...DEFAULTS.fuzzing, ...(raw.fuzzing ?? {}) } };
  config.excluded_repos = config.excluded_repos ?? [];
  const fail = message => { throw new Error(`${message} (in ${configPath})`); };

  if (typeof config.scorecard_version !== 'string' || !config.scorecard_version) fail('Config missing required field: scorecard_version');
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) fail('Config field concurrency must be a positive integer');
  if (typeof config.create_repos_config !== 'string' || !config.create_repos_config) fail('Config field create_repos_config must be a file path');
  if (!isStringList(config.not_applicable_topics)) fail('Config field not_applicable_topics must be a list of topics');
  if (!isStringList(config.fuzzing.languages)) fail('Config field fuzzing.languages must be a list of languages');
  const share = config.fuzzing.min_share;
  if (typeof share !== 'number' || share < 0 || share > 100) fail('Config field fuzzing.min_share must be a number from 0 to 100');
  if (!isPlainObject(config.thresholds) || Object.keys(config.thresholds).length === 0) fail('Config missing required field: thresholds');
  for (const [name, threshold] of Object.entries(config.thresholds)) {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10) fail(`Threshold of ${name} must be an integer from 0 to 10`);
  }
  return config;
}

/** Names of the repositories with `branch-protection: managed` in the create_repos configuration. */
export async function loadManagedRepos(createReposConfigPath) {
  const { repositories } = await loadCreateReposConfig(createReposConfigPath);
  return new Set(repositories.filter(r => r['branch-protection'] === 'managed').map(r => r.name));
}

// ── Applicability ────────────────────────────────────────────────────────────

const formatShare = share => `${Number(share.toFixed(1))}%`;

/**
 * Whether Fuzzing applies: a listed (non-memory-safe) language has more than `min_share` percent
 * of the code bytes. Returns `{ applies, line }`; `line` is the first details line of the result.
 */
export function fuzzingApplicability(languageBytes, { languages, min_share: minShare }) {
  const total = Object.values(languageBytes).reduce((sum, bytes) => sum + bytes, 0);
  const found = languages
    .filter(lang => languageBytes[lang] > 0)
    .map(lang => ({ lang, share: (languageBytes[lang] / total) * 100 }))
    .sort((a, b) => b.share - a.share);
  const listed = found.map(f => `${f.lang} ${formatShare(f.share)}`).join(', ');
  if (found.some(f => f.share > minShare)) return { applies: true, line: `Info: scorecard_check: applies, ${listed}` };
  const below = found.length > 0 ? ` (${listed})` : '';
  return {
    applies: false,
    line: `Info: scorecard_check: not applicable, no non-memory-safe language (${languages.join(', ')}) above ${minShare}%${below}`,
  };
}

/** scorecard_check's own decision for a check: `{ na, line }`, `{ line }` (extra details line), `{ error }` or null. */
function ownDecision(name, { managed, topics, naTopics, fuzzing }) {
  if (name === BRANCH_PROTECTION && managed) {
    return { na: true, line: `Info: scorecard_check: not evaluated, branch-protection is managed by the org ruleset ${MANAGED_RULESET}` };
  }
  if (name === CI_TESTS) {
    const topic = topics.find(t => naTopics.includes(t));
    if (topic) return { na: true, line: `Info: scorecard_check: not applicable, topic '${topic}'` };
  }
  if (name === FUZZING) {
    if (fuzzing.error) return { error: fuzzing.error };
    return fuzzing.applies ? { line: fuzzing.line } : { na: true, line: fuzzing.line };
  }
  return null;
}

const isInternalError = check => check.score === -1 && /^internal error/i.test(check.reason ?? '');

/**
 * The number of changesets on the default branch, read from Scorecard's Code-Review result:
 * `{ count }`, or `{ error }` when Code-Review is missing, failed, or uses a wording that is not known.
 */
export function countChangesets(codeReview) {
  if (!codeReview) return { error: `${CODE_REVIEW} not in Scorecard output` };
  if (isInternalError(codeReview)) return { error: `${CODE_REVIEW} failed: ${codeReview.reason}` };
  if (codeReview.score === -1) return { count: 0 };
  const reason = codeReview.reason ?? '';
  const found = /^Found (\d+)\/(\d+) approved changesets/.exec(reason);
  if (found) return { count: Number(found[2]) };
  if (/^all changesets reviewed/.test(reason) || /^no changesets (found|detected)/.test(reason)) return { count: 0 };
  return { error: `unrecognised ${CODE_REVIEW} reason: "${reason}"` };
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Converts one Scorecard output into results and errors for the configured checks (in `thresholds`
 * order). `ignored` lists the checks of the output that are not configured.
 * Context: `managed` (branch protection by the org ruleset), `topics`, `naTopics`, `fuzzing`
 * (`fuzzingApplicability` result, or `{ error }`).
 */
export function convertChecks(output, { thresholds, managed = false, topics = [], naTopics = [], fuzzing }) {
  const byCheckName = new Map(output.checks.map(c => [c.name, c]));
  const results = [];
  const errors = [];
  for (const [name, threshold] of Object.entries(thresholds)) {
    const check = checkId(name);
    const sc = byCheckName.get(name);
    if (!sc) {
      errors.push({ check, reason: `${name} not in Scorecard output` });
      continue;
    }
    const base = { check, name, score: sc.score === -1 ? null : sc.score, reason: sc.reason, details: sc.details ?? [] };
    const decision = ownDecision(name, { managed, topics, naTopics, fuzzing });
    if (decision?.error) {
      errors.push({ check, reason: decision.error });
      continue;
    }
    const lines = decision?.line ? [decision.line] : [];
    if (decision?.na) {
      results.push({ ...base, result: 'na', details: [...lines, ...base.details] });
      continue;
    }
    if (isInternalError(sc)) {
      errors.push({ check, reason: sc.reason });
      continue;
    }
    if (sc.score === -1 && name === CI_TESTS) {
      const changesets = countChangesets(byCheckName.get(CODE_REVIEW));
      if (changesets.error) {
        errors.push({ check, reason: changesets.error });
      } else if (changesets.count > 0) {
        const line = `Warn: scorecard_check: ${plural(changesets.count, 'changeset')} reached the default branch without pull requests`;
        results.push({ ...base, result: 'fail', details: [line, ...base.details] });
      } else {
        results.push({ ...base, result: 'na', details: [...lines, ...base.details] });
      }
      continue;
    }
    const result = sc.score === -1 ? 'na' : sc.score >= threshold ? 'pass' : 'fail';
    results.push({ ...base, result, details: [...lines, ...base.details] });
  }
  const ignored = output.checks.map(c => c.name).filter(name => !(name in thresholds));
  return { results, errors, ignored };
}

const utc = date => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

/** The `repositories` entry of a scanned repository: scanned commit, date (UTC) and overall score. */
export function repositoryEntry(repo, output) {
  return { repo, commit: output.repo?.commit ?? null, date: utc(output.date), score: output.score ?? null };
}

// ── JSON output ──────────────────────────────────────────────────────────────

/** Notes on the applicability rules of scorecard_check, appended to Scorecard's own short description. */
export function applicabilityNotes({ naTopics, fuzzing }) {
  return {
    [BRANCH_PROTECTION]: `Not applicable to repositories with branch-protection: managed in create_repos.yaml: they are protected by the org ruleset ${MANAGED_RULESET}.`,
    [CI_TESTS]: `Not applicable to repositories with topic ${naTopics.join(' or ')}. Inconclusive (-1) is not applicable, unless Code-Review counted changesets: then changes reached the default branch without pull requests, and the result is fail.`,
    [FUZZING]: `Applies only to repositories with more than ${fuzzing.min_share}% code in a non-memory-safe language (${fuzzing.languages.join(', ')}); all others are not applicable.`,
  };
}

/**
 * One catalogue entry per configured check: name, threshold and Scorecard's documentation (from the
 * first output that has the check; otherwise a link to the docs of the Scorecard commit).
 */
export function buildCatalogue({ thresholds, outputs, scorecardCommit, notes = {} }) {
  const docs = new Map();
  for (const output of outputs) {
    for (const c of output.checks) if (c.documentation && !docs.has(c.name)) docs.set(c.name, c.documentation);
  }
  const catalogue = {};
  for (const [name, threshold] of Object.entries(thresholds)) {
    const doc = docs.get(name);
    const url = doc?.url ?? `${SCORECARD_REPO}/blob/${scorecardCommit ?? 'main'}/docs/checks.md#${headingSlug(name)}`;
    const short = [doc?.short ?? `Scorecard check ${name}.`, notes[name]].filter(Boolean).join(' ');
    catalogue[checkId(name)] = { name, threshold, documentation: { url, short } };
  }
  return catalogue;
}

/**
 * Results sorted by repository (each in `thresholds` order), skipped and errors. A repository that
 * could not be scanned gets one `errors` row per configured check.
 */
export function buildJsonResults({ evaluated, archived, excluded, catalogue, thresholds }) {
  const sorted = [...evaluated].sort((a, b) => a.repo.localeCompare(b.repo));
  const results = [];
  const errors = [];
  for (const e of sorted) {
    if (e.error) {
      for (const name of Object.keys(thresholds)) errors.push({ repo: e.repo, check: checkId(name), reason: e.error });
      continue;
    }
    for (const r of e.results) {
      results.push({ ...checkResult(e.repo, r.check, catalogue, { result: r.result, reason: r.reason, details: r.details }), score: r.score });
    }
    for (const err of e.errors) errors.push({ repo: e.repo, ...err });
  }
  return {
    results,
    skipped: [...skippedRepos(archived, 'archived'), ...skippedRepos(excluded, 'excluded_repos')],
    errors,
  };
}

// ── Scorecard CLI ────────────────────────────────────────────────────────────

export const NO_CHECKS = 'Scorecard returned no checks (empty repository or no read access)';

const parseJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Parses Scorecard's JSON output; null if it is not JSON or has no `checks` list. */
export function parseOutput(text) {
  const output = parseJson(text);
  return Array.isArray(output?.checks) ? output : null;
}

const lastLine = text => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';

/**
 * The Scorecard CLI: `version()` → `{ version, commit }`, `scan(org, repo)` → parsed output.
 * `scan` throws a plain Error when there is no usable output; a missing binary is a ScriptError.
 * Scorecard can exit non-zero when one check has a runtime error and still print its JSON, which is used.
 */
export function createScorecardCli({ bin = 'scorecard', env = {}, execFile = promisify(nodeExecFile) } = {}) {
  const notFound = () => new ScriptError(`Scorecard CLI not found: ${bin} (install it or set SCORECARD_BIN)`);
  const exec = async (args, options = {}) => {
    try {
      return { ...(await execFile(bin, args, { env, maxBuffer: MAX_BUFFER, ...options })), failure: null };
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound();
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', failure: err };
    }
  };
  return {
    async version() {
      const { stdout, stderr, failure } = await exec(['version']);
      const text = `${stdout}\n${stderr}`;
      const version = /GitVersion:\s*(\S+)/.exec(text)?.[1];
      if (!version) throw new ScriptError(`Could not read the Scorecard version from "${bin} version"${failure ? `: ${failure.message}` : ''}`);
      return { version, commit: /GitCommit:\s*(\S+)/.exec(text)?.[1] ?? null };
    },

    async scan(org, repo) {
      const { stdout, stderr, failure } = await exec(
        [`--repo=github.com/${org}/${repo}`, '--format=json', '--show-details'],
        { timeout: SCAN_TIMEOUT_MS },
      );
      const output = parseOutput(stdout);
      if (output) return output;
      // An empty repository gives a valid result with `checks: null` (and commit "HEAD").
      if (parseJson(stdout)?.checks === null) throw new Error(NO_CHECKS);
      if (!failure) throw new Error('Scorecard output is not valid JSON');
      const why = failure.killed ? 'timeout' : `exit code ${failure.code}`;
      throw new Error(`Scorecard failed (${why})${lastLine(stderr) ? `: ${lastLine(stderr)}` : ''}`);
    },
  };
}

// ── Per repository ───────────────────────────────────────────────────────────

async function readLanguages(gh, org, repo) {
  try {
    return await gh.listLanguages(org, repo);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function evaluateRepo({ gh, sc, org, repo, config, managed }) {
  let output;
  try {
    output = await sc.scan(org, repo.name);
  } catch (err) {
    if (err instanceof ScriptError) throw err;
    return { repo: repo.name, error: err.message };
  }
  const languages = await readLanguages(gh, org, repo.name);
  const fuzzing = languages ? fuzzingApplicability(languages, config.fuzzing) : { error: LANGUAGES_NOT_READABLE };
  return {
    repo: repo.name,
    output,
    ...convertChecks(output, {
      thresholds: config.thresholds,
      managed: managed.has(repo.name),
      topics: repo.topics ?? [],
      naTopics: config.not_applicable_topics,
      fuzzing,
    }),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** "Code-Review 4 (< 7): reason"; for a decision without score, the decision line of scorecard_check. */
function describeResult(r, thresholds) {
  const own = r.details[0]?.match(/^\w+: scorecard_check: (.*)$/)?.[1];
  if (r.result === 'fail') {
    return r.score === null ? `${r.name}: ${own ?? r.reason}` : `${r.name} ${r.score} (< ${thresholds[r.name]}): ${r.reason}`;
  }
  if (r.result === 'na') return `${r.name} na: ${own ?? r.reason}`;
  return `${r.name} ${r.score}: ${r.reason}`;
}

function logRepo(log, e, thresholds, debug) {
  if (e.error) return log.info(`  ${e.repo}: not scanned: ${e.error}`);
  for (const r of e.results) {
    if (r.result === 'fail' || debug) log.info(`  ${e.repo}: ${describeResult(r, thresholds)}`);
  }
  for (const err of e.errors) {
    const name = Object.keys(thresholds).find(n => checkId(n) === err.check);
    log.info(`  ${e.repo}: ${name}: error: ${err.reason}`);
  }
}

export async function run({ argv = [], env = {}, logger, github, scorecard, now = new Date(), git } = {}) {
  const { org, configPath, debug, json } = parseCli(argv, { defaultConfigPath: defaultConfigPath(TOOL), stringFlags: ['json'] });
  if (!json) throw new ScriptError('--json is required');
  const gh = github ?? createGitHub(createOctokit(resolveToken(env)));
  const sc = scorecard ?? createScorecardCli({ bin: env.SCORECARD_BIN || 'scorecard', env: { ...env, GITHUB_AUTH_TOKEN: resolveToken(env) } });
  const log = logger ?? createLogger({ debug });
  const config = await loadConfig(configPath);
  const managed = await loadManagedRepos(path.resolve(repoRoot, config.create_repos_config));

  const version = await sc.version();
  if (version.version !== config.scorecard_version) {
    throw new ScriptError(`Scorecard ${version.version} found, but ${path.basename(configPath)} pins ${config.scorecard_version}`);
  }

  const { active, archived, excluded } = partitionRepos(await gh.listOrgRepos(org), config.excluded_repos);
  log.info(`Active repositories: ${active.length} (archived: ${archived.length}, excluded: ${excluded.length})`);
  log.info(`Scorecard ${version.version}${version.commit ? ` (${version.commit.slice(0, 7)})` : ''}`);
  log.debug(`Managed branch protection: ${plural(managed.size, 'repository', 'repositories')} (from ${config.create_repos_config})`);

  // Progress: a scan takes up to minutes per repository, so report each one as it finishes.
  log.info(`Scanning ${plural(active.length, 'repository', 'repositories')} (${config.concurrency} at a time)...`);
  let done = 0;
  const evaluated = await mapWithConcurrency([...active].sort(byName), config.concurrency, async repo => {
    const e = await evaluateRepo({ gh, sc, org, repo, config, managed });
    done += 1;
    log.info(`  [${done}/${active.length}] ${e.repo}: ${e.error ? 'not scanned' : `score ${e.output.score ?? 'n/a'}`}`);
    return e;
  });
  log.info('');

  for (const e of evaluated) logRepo(log, e, config.thresholds, debug);
  const scanned = evaluated.filter(e => !e.error);
  const ignored = [...new Set(scanned.flatMap(e => e.ignored))].sort();
  if (ignored.length > 0) log.info(`Not configured in thresholds, ignored: ${ignored.join(', ')}`);
  const failing = scanned.filter(e => e.results.some(r => r.result === 'fail'));
  const withErrors = evaluated.filter(e => e.error || e.errors.length > 0);
  log.info(`Scanned repositories: ${scanned.length}`);
  log.info(failing.length > 0 ? `Findings: ${plural(failing.length, 'repository', 'repositories')}` : 'No findings.');
  if (withErrors.length > 0) log.info(`Errors: ${plural(withErrors.length, 'repository', 'repositories')}`);

  const baseHeader = await buildHeader({ tool: TOOL, org, configPath, issueTitle: null, env, now, git });
  const header = { ...baseHeader, source: SOURCE, scorecard_version: version.version, scorecard_commit: version.commit };
  const catalogue = buildCatalogue({
    thresholds: config.thresholds,
    outputs: scanned.map(e => e.output),
    scorecardCommit: version.commit,
    notes: applicabilityNotes({ naTopics: config.not_applicable_topics, fuzzing: config.fuzzing }),
  });
  const doc = buildJsonDocument(header, {
    catalogue,
    ...buildJsonResults({ evaluated, archived, excluded, catalogue, thresholds: config.thresholds }),
  });
  const repositories = [...scanned].sort((a, b) => a.repo.localeCompare(b.repo)).map(e => repositoryEntry(e.repo, e.output));
  await writeJsonReport(path.resolve(json), { ...doc, repositories });
  log.info(`\nJSON written to ${json}`);
  return 0;
}

runIfMain(import.meta.url, run);
