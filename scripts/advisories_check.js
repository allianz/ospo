#!/usr/bin/env node

// Checks that the security advisories of every repository were published in reasonable time.
// Reads published (public) advisories only. JSON only: no issues, no writes to GitHub.
// See spec/advisories_check_spec.md.

import path from 'node:path';

import { ScriptError, parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { defaultConfigPath, loadYaml } from './lib/config.js';
import { parseRelativeDate } from './lib/dates.js';
import { createGitHub, createOctokit, isNotFound } from './lib/github.js';
import { buildHeader, buildJsonDocument, checkResult, skippedRepos, specCatalogue, writeJsonReport } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';
import { byName, partitionRepos } from './lib/repos.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const TOOL = 'advisories_check';
export const CHECK = 'advisories/published-in-time';
const SPEC_FILE = 'advisories_check_spec.md';
const CONCURRENCY = 8;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
export const DEFAULTS = { max_days: 90, lookback: '12 months' };

const plural = (n, singular, pluralForm = `${singular}s`) => `${n} ${n === 1 ? singular : pluralForm}`;

// ── Config ───────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const config = { ...DEFAULTS, ...((await loadYaml(configPath)) ?? {}) };
  config.excluded_repos = config.excluded_repos ?? [];
  if (!Number.isInteger(config.max_days) || config.max_days < 1) {
    throw new Error(`Config field max_days must be a positive integer (in ${configPath})`);
  }
  parseRelativeDate(config.lookback);
  return config;
}

// ── Check ────────────────────────────────────────────────────────────────────

/**
 * Judges the advisories of one repository: those published since `since` must each have been
 * published at most `maxDays` days after their creation. No advisory in the window passes.
 */
export function evaluateAdvisories(advisories, { since, maxDays, lookback }) {
  const recent = advisories
    .filter(a => new Date(a.published_at) >= since)
    .map(a => ({
      id: a.ghsa_id,
      created: a.created_at,
      published: a.published_at,
      days: Math.floor((new Date(a.published_at) - new Date(a.created_at)) / MS_PER_DAY),
    }))
    .sort((a, b) => new Date(a.published) - new Date(b.published));

  if (recent.length === 0) return { passed: true, count: 0, reason: `No advisory published in the last ${lookback}`, details: [] };

  const late = recent.filter(a => a.days > maxDays);
  const after = a => `${a.id} after ${plural(a.days, 'day')}`;
  const advisoryCount = plural(recent.length, 'advisory', 'advisories');
  const reason = late.length === 0
    ? `${advisoryCount} published in the last ${lookback}: ${recent.map(after).join(', ')}`
    : `${late.length} of ${advisoryCount} published later than ${maxDays} days: ${late.map(after).join(', ')}`;
  const details = recent.map(a =>
    `${a.days > maxDays ? 'Warn' : 'Info'}: ${a.id} created ${a.created.slice(0, 10)}, published ${a.published.slice(0, 10)} (${plural(a.days, 'day')})`,
  );
  return { passed: late.length === 0, count: recent.length, reason, details };
}

// ── JSON output ──────────────────────────────────────────────────────────────

export function buildCatalogue({ maxDays, lookback, sha = null, env = {} }) {
  const entry = specCatalogue(SPEC_FILE, { sha, env });
  return {
    [CHECK]: entry(
      'Advisories Published in Time',
      `Every security advisory of the repository published in the last ${lookback} was published within ${maxDays} days of its creation. Only published advisories are counted; they are public.`,
      `Project team with the OSPO: publish advisories within ${maxDays} days of the report. A late publication counts for ${lookback}.`,
    ),
  };
}

export const NOT_READABLE = 'Security advisories not readable (request returned 404: private repository or missing permission)';

/**
 * One result per evaluated repository, sorted by repository; archived and excluded repositories are skipped.
 * A repository whose advisories could not be read gets an `errors` entry instead of a result ("no data").
 */
export function buildJsonResults({ evaluated, archived, excluded, catalogue }) {
  const sorted = [...evaluated].sort((a, b) => a.repo.localeCompare(b.repo));
  return {
    results: sorted
      .filter(e => !e.error)
      .map(({ repo, passed, reason, details }) => checkResult(repo, CHECK, catalogue, { passed, reason, details })),
    skipped: [...skippedRepos(archived, 'archived'), ...skippedRepos(excluded, 'excluded_repos')],
    errors: sorted.filter(e => e.error).map(({ repo, error }) => ({ repo, check: CHECK, reason: error })),
  };
}

/** The published advisories of a repository, or null if GitHub answers 404 (private repository or missing permission). */
async function readAdvisories(gh, org, repo) {
  try {
    return await gh.listPublishedAdvisories(org, repo);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger, github, git, now = new Date() } = {}) {
  const { org, configPath, debug, json } = parseCli(argv, { defaultConfigPath: defaultConfigPath(TOOL), stringFlags: ['json'] });
  if (!json) throw new ScriptError('--json is required');
  const gh = github ?? createGitHub(createOctokit(resolveToken(env)));
  const log = logger ?? createLogger({ debug });
  const config = await loadConfig(configPath);
  const since = parseRelativeDate(config.lookback, now);

  const { active, archived, excluded } = partitionRepos(await gh.listOrgRepos(org), config.excluded_repos);
  log.info(`Active repositories: ${active.length} (archived: ${archived.length}, excluded: ${excluded.length})`);
  log.debug(`Advisories published since ${since.toISOString()}, at most ${config.max_days} days after creation`);

  const evaluated = await mapWithConcurrency([...active].sort(byName), CONCURRENCY, async repo => {
    const advisories = await readAdvisories(gh, org, repo.name);
    if (!advisories) return { repo: repo.name, error: NOT_READABLE };
    return { repo: repo.name, ...evaluateAdvisories(advisories, { since, maxDays: config.max_days, lookback: config.lookback }) };
  });

  for (const e of evaluated) {
    if (e.error) log.info(`  ${e.repo}: ${e.error}`);
    else if (e.count > 0 || debug) log.info(`  ${e.repo}: ${e.reason}`);
  }
  const late = evaluated.filter(e => !e.error && !e.passed);
  const unreadable = evaluated.filter(e => e.error);
  log.info(late.length > 0 ? `Late publications: ${plural(late.length, 'repository', 'repositories')}` : 'All advisories published in time.');
  if (unreadable.length > 0) log.info(`Not readable (in errors): ${plural(unreadable.length, 'repository', 'repositories')}`);

  const header = await buildHeader({ tool: TOOL, org, configPath, issueTitle: null, env, now, git });
  const catalogue = buildCatalogue({ maxDays: config.max_days, lookback: config.lookback, sha: header.ospo_sha, env });
  const doc = buildJsonDocument(header, { catalogue, ...buildJsonResults({ evaluated, archived, excluded, catalogue }) });
  await writeJsonReport(path.resolve(json), doc);
  log.info(`\nJSON written to ${json}`);
  return 0;
}

runIfMain(import.meta.url, run);
