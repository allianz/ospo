#!/usr/bin/env node

// Checks the GitHub releases of every repository: version identifiers (SemVer/CalVer, increasing)
// and release notes. JSON only: no issues, no writes to GitHub.
// See spec/releases_check_spec.md.

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

export const TOOL = 'releases_check';
export const VERSIONING = 'releases/versioning';
export const RELEASE_NOTES = 'releases/release-notes';
export const CHECKS = [VERSIONING, RELEASE_NOTES];
const SPEC_FILE = 'releases_check_spec.md';
const CONCURRENCY = 8;
export const DEFAULTS = { lookback: '12 months', min_notes_chars: 50 };
const CHECK_LABELS = { [VERSIONING]: 'versioning', [RELEASE_NOTES]: 'release notes' };

const plural = (n, singular, pluralForm = `${singular}s`) => `${n} ${n === 1 ? singular : pluralForm}`;
const day = date => date.slice(0, 10);

// ── Config ───────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const config = { ...DEFAULTS, ...((await loadYaml(configPath)) ?? {}) };
  config.excluded_repos = config.excluded_repos ?? [];
  if (!Number.isInteger(config.min_notes_chars) || config.min_notes_chars < 1) {
    throw new Error(`Config field min_notes_chars must be a positive integer (in ${configPath})`);
  }
  parseRelativeDate(config.lookback);
  return config;
}

// ── Versions ─────────────────────────────────────────────────────────────────

const IDENT = '[0-9A-Za-z-]+';
const VERSION_RE = new RegExp(`^v?(\\d+)\\.(\\d+)(?:\\.(\\d+))?(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`);

/**
 * Parses a SemVer or CalVer tag: an optional "v", two or three numeric parts, an optional
 * pre-release and optional build metadata (e.g. v1.2.3, 2026.11, 2026.11.0-rc.1).
 * A missing third part counts as 0. Returns null if the tag is neither.
 */
export function parseVersion(tag) {
  const match = VERSION_RE.exec(String(tag));
  if (!match) return null;
  const nums = [match[1], match[2], match[3] ?? '0'].map(Number);
  return { major: nums[0], nums, pre: match[4] ? match[4].split('.') : [] };
}

const isNumeric = id => /^\d+$/.test(id);

function comparePreIds(a, b) {
  if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
  if (isNumeric(a)) return -1;
  if (isNumeric(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence of two parsed versions (< 0, 0, > 0). Build metadata is ignored. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const c = comparePreIds(a.pre[i], b.pre[i]);
    if (c !== 0) return c;
  }
  return a.pre.length - b.pre.length;
}

// ── Checks ───────────────────────────────────────────────────────────────────

/** The published (not draft) releases published since `since`, oldest first. */
export function releasesInWindow(releases, since) {
  return releases
    .filter(r => !r.draft && r.published_at && new Date(r.published_at) >= since)
    .sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
}

/**
 * Every tag is SemVer or CalVer, and within each major version line every release has a higher
 * version than all releases of that line published before it. `releases` is sorted by publication.
 */
export function evaluateVersioning(releases) {
  const tags = releases.map(r => r.tag_name);
  const invalid = [];
  const backwards = [];
  const highest = new Map(); // major → { version, release }
  for (const release of releases) {
    const version = parseVersion(release.tag_name);
    if (!version) {
      invalid.push(release);
      continue;
    }
    const top = highest.get(version.major);
    if (top && compareVersions(version, top.version) <= 0) backwards.push({ release, after: top.release, major: version.major });
    else highest.set(version.major, { version, release });
  }

  const details = [`Info: releases checked: ${tags.join(', ')}`];
  for (const r of invalid) details.push(`Warn: ${r.tag_name} (${day(r.published_at)}) is not SemVer or CalVer`);
  for (const b of backwards) {
    details.push(`Warn: ${b.release.tag_name} (${day(b.release.published_at)}) is not higher than ${b.after.tag_name} (${day(b.after.published_at)}) in major line ${b.major}`);
  }

  if (invalid.length === 0 && backwards.length === 0) {
    const subject = releases.length === 1 ? '1 release follows' : `${releases.length} releases follow`;
    return { passed: true, reason: `${subject} SemVer or CalVer, increasing within each major line`, details };
  }
  const parts = [];
  if (invalid.length > 0) parts.push(`${invalid.length} of ${plural(releases.length, 'release')} not SemVer or CalVer: ${invalid.map(r => r.tag_name).join(', ')}`);
  if (backwards.length > 0) {
    parts.push(`version not increasing: ${backwards.map(b => `${b.release.tag_name} after ${b.after.tag_name} in major line ${b.major}`).join(', ')}`);
  }
  return { passed: false, reason: parts.join('; '), details };
}

const bodyLength = release => (release.body ?? '').trim().length;

/** True if the release body alone is long enough to count as release notes. */
export const hasBodyNotes = (release, minChars) => bodyLength(release) >= minChars;

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True if `text` mentions the version of `tag` (with or without "v"), not as part of a longer version. */
export function mentionsVersion(text, tag) {
  const version = String(tag).replace(/^v/, '');
  return new RegExp(`(?<![0-9A-Za-z.+-])v?${escapeRegExp(version)}(?![0-9A-Za-z+-]|\\.[0-9A-Za-z])`).test(text);
}

/**
 * Every release has notes: a body of at least `minChars` characters (trimmed), or its version is
 * mentioned in the changelog (`{ file, text }` or null). `releases` is sorted by publication.
 */
export function evaluateReleaseNotes(releases, { minChars, changelog = null }) {
  const judged = releases.map(r => {
    if (hasBodyNotes(r, minChars)) return { release: r, source: 'body' };
    if (changelog && mentionsVersion(changelog.text, r.tag_name)) return { release: r, source: 'changelog' };
    return { release: r, source: null };
  });
  const details = judged.map(({ release, source }) => {
    const length = bodyLength(release);
    if (source === 'body') return `Info: ${release.tag_name} release body (${plural(length, 'character')})`;
    if (source === 'changelog') return `Info: ${release.tag_name} mentioned in ${changelog.file}`;
    const where = changelog ? `not mentioned in ${changelog.file}` : 'no CHANGELOG file';
    return `Warn: ${release.tag_name} release body has ${plural(length, 'character')} (minimum ${minChars}), ${where}`;
  });

  const missing = judged.filter(j => !j.source);
  if (missing.length > 0) {
    return {
      passed: false,
      reason: `${missing.length} of ${plural(releases.length, 'release')} without notes: ${missing.map(j => j.release.tag_name).join(', ')}`,
      details,
    };
  }
  const source = judged.some(j => j.source === 'changelog') ? `release body or ${changelog.file}` : 'release body';
  const all = releases.length === 1 ? 'The release has' : `All ${releases.length} releases have`;
  return { passed: true, reason: `${all} notes (${source})`, details };
}

// ── JSON output ──────────────────────────────────────────────────────────────

export function buildCatalogue({ lookback, minChars, sha = null, env = {} }) {
  const entry = specCatalogue(SPEC_FILE, { sha, env });
  return {
    [VERSIONING]: entry(
      'Versioning',
      `Every release of the repository published in the last ${lookback} has a SemVer or CalVer tag (optional "v" prefix), and within each major version line the versions increase with the release date. Not applicable without a release in that period.`,
      `Project team: tag releases with SemVer or CalVer (e.g. v1.4.2) and keep versions increasing within each major line. A release that breaks the rule counts for ${lookback} unless its tag is corrected.`,
    ),
    [RELEASE_NOTES]: entry(
      'Release Notes',
      `Every release of the repository published in the last ${lookback} has a release body of at least ${minChars} characters, or a CHANGELOG file in the repository root mentions its version. Not applicable without a release in that period.`,
      'Project team: describe the functional and security changes in the GitHub release (or let GitHub generate the notes), or list the version in CHANGELOG.md. Editing an existing release fixes the finding.',
    ),
  };
}

export const NOT_READABLE = 'Releases not readable (request returned 404: private repository or missing permission)';

/**
 * Two results (one per check) per evaluated repository, sorted by repository; archived and excluded
 * repositories are skipped. A repository whose releases could not be read gets one `errors` entry per check.
 */
export function buildJsonResults({ evaluated, archived, excluded, catalogue }) {
  const sorted = [...evaluated].sort((a, b) => a.repo.localeCompare(b.repo));
  const results = [];
  for (const e of sorted) {
    if (e.error) continue;
    if (e.na) {
      for (const check of CHECKS) results.push(checkResult(e.repo, check, catalogue, { result: 'na', reason: e.reason }));
      continue;
    }
    results.push(checkResult(e.repo, VERSIONING, catalogue, e.versioning));
    results.push(checkResult(e.repo, RELEASE_NOTES, catalogue, e.notes));
  }
  return {
    results,
    skipped: [...skippedRepos(archived, 'archived'), ...skippedRepos(excluded, 'excluded_repos')],
    errors: sorted.filter(e => e.error).flatMap(({ repo, error }) => CHECKS.map(check => ({ repo, check, reason: error }))),
  };
}

// ── GitHub reads ─────────────────────────────────────────────────────────────

/** Returns `fn()`, or `fallback` if GitHub answers 404. */
async function unlessNotFound(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (isNotFound(err)) return fallback;
    throw err;
  }
}

/** The CHANGELOG* file in the repository root as `{ file, text }`, or null if there is none (or the repository is empty). */
export async function readChangelog(gh, org, repo) {
  const files = await unlessNotFound(() => gh.listRootFiles(org, repo), []);
  const file = files.filter(name => /^changelog/i.test(name)).sort()[0];
  if (!file) return null;
  const text = await unlessNotFound(() => gh.getFileText(org, repo, file), null);
  return text === null ? null : { file, text };
}

async function evaluateRepo(gh, org, repo, { since, lookback, minChars }) {
  const all = await unlessNotFound(() => gh.listReleases(org, repo), null);
  if (!all) return { repo, error: NOT_READABLE };
  const releases = releasesInWindow(all, since);
  if (releases.length === 0) return { repo, na: true, reason: `No release in the last ${lookback}` };
  const changelog = releases.every(r => hasBodyNotes(r, minChars)) ? null : await readChangelog(gh, org, repo);
  return {
    repo,
    count: releases.length,
    versioning: evaluateVersioning(releases),
    notes: evaluateReleaseNotes(releases, { minChars, changelog }),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function logRepo(log, e, debug) {
  if (e.error) return log.info(`  ${e.repo}: ${e.error}`);
  if (e.na) {
    if (debug) log.info(`  ${e.repo}: ${e.reason}`);
    return;
  }
  for (const [check, outcome] of [[VERSIONING, e.versioning], [RELEASE_NOTES, e.notes]]) {
    if (!outcome.passed || debug) log.info(`  ${e.repo}: ${CHECK_LABELS[check]}: ${outcome.reason}`);
  }
}

export async function run({ argv = [], env = {}, logger, github, git, now = new Date() } = {}) {
  const { org, configPath, debug, json } = parseCli(argv, { defaultConfigPath: defaultConfigPath(TOOL), stringFlags: ['json'] });
  if (!json) throw new ScriptError('--json is required');
  const gh = github ?? createGitHub(createOctokit(resolveToken(env)));
  const log = logger ?? createLogger({ debug });
  const config = await loadConfig(configPath);
  const since = parseRelativeDate(config.lookback, now);
  const options = { since, lookback: config.lookback, minChars: config.min_notes_chars };

  const { active, archived, excluded } = partitionRepos(await gh.listOrgRepos(org), config.excluded_repos);
  log.info(`Active repositories: ${active.length} (archived: ${archived.length}, excluded: ${excluded.length})`);
  log.debug(`Releases published since ${since.toISOString()}, release notes of at least ${config.min_notes_chars} characters`);

  const evaluated = await mapWithConcurrency([...active].sort(byName), CONCURRENCY, repo => evaluateRepo(gh, org, repo.name, options));

  for (const e of evaluated) logRepo(log, e, debug);
  const releasing = evaluated.filter(e => !e.error && !e.na);
  const failing = releasing.filter(e => !e.versioning.passed || !e.notes.passed);
  const unreadable = evaluated.filter(e => e.error);
  log.info(`Releasing repositories: ${releasing.length}`);
  log.info(failing.length > 0 ? `Findings: ${plural(failing.length, 'repository', 'repositories')}` : 'All releases versioned and documented.');
  if (unreadable.length > 0) log.info(`Not readable (in errors): ${plural(unreadable.length, 'repository', 'repositories')}`);

  const header = await buildHeader({ tool: TOOL, org, configPath, issueTitle: null, env, now, git });
  const catalogue = buildCatalogue({ lookback: config.lookback, minChars: config.min_notes_chars, sha: header.ospo_sha, env });
  const doc = buildJsonDocument(header, { catalogue, ...buildJsonResults({ evaluated, archived, excluded, catalogue }) });
  await writeJsonReport(path.resolve(json), doc);
  log.info(`\nJSON written to ${json}`);
  return 0;
}

runIfMain(import.meta.url, run);
