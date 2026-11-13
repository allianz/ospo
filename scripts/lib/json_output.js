// The common JSON result format written by the checking scripts with --json <file>.
// See scripts/spec/reports_compliance_spec.md, section "Tool file format".

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { repoRoot } from './config.js';

/** The repository that holds these scripts, used when GITHUB_REPOSITORY is not set (local runs). */
export const DEFAULT_OSPO_REPO = 'allianz/ospo';
const DEFAULT_SERVER_URL = 'https://github.com';
const RESULTS = ['pass', 'fail', 'na'];

/** The commit of the scripts: GITHUB_SHA in Actions, otherwise HEAD of the local checkout, or null. */
export async function resolveOspoSha(env = {}, git = simpleGit) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  try {
    return (await git(repoRoot).revparse(['HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/** Link to the GitHub Actions run, or null outside Actions. */
export function runUrl(env = {}) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL ?? DEFAULT_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/** The anchor GitHub generates for a Markdown heading ("License Type" → "license-type"). */
export function headingSlug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** URL of a file in the ospo repository (path relative to its root), pinned to a commit (or main when it is unknown). */
export function blobUrl(filePath, { sha = null, env = {} } = {}) {
  const server = env.GITHUB_SERVER_URL ?? DEFAULT_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY ?? DEFAULT_OSPO_REPO;
  return `${server}/${repo}/blob/${sha ?? 'main'}/${filePath}`;
}

/** URL of a heading in a spec file, pinned to the commit of the scripts (or main when it is unknown). */
export function specUrl(specFile, heading, { sha = null, env = {} } = {}) {
  return `${blobUrl(`scripts/spec/${specFile}`, { sha, env })}#${headingSlug(heading)}`;
}

/** SHA-256 (hex) of a string or buffer. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** A path relative to the repo root, with forward slashes (as written into the JSON files). */
export function repoRelative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/** A date as ISO 8601 UTC without milliseconds ("2026-11-03T02:00:00Z"). */
export function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Returns a function that builds catalogue entries documented in one spec file:
 *   const entry = specCatalogue('lint_repos_spec.md', { sha, env });
 *   entry('License Type', 'The license … is approved.', 'Use an approved license.')
 */
export function specCatalogue(specFile, { sha = null, env = {} } = {}) {
  return (name, short, fix) => ({ name, documentation: { url: specUrl(specFile, name, { sha, env }), short, fix } });
}

/** The header fields of a tool file. */
export async function buildHeader({ tool, org, configPath, issueTitle, env = {}, now = new Date(), git }) {
  const raw = await readFile(configPath);
  return {
    tool,
    run_at: isoSeconds(now),
    org,
    ospo_sha: await resolveOspoSha(env, git),
    config_file: repoRelative(configPath),
    config_sha256: sha256(raw),
    run_url: runUrl(env),
    issue_title: issueTitle ?? null,
  };
}

/**
 * One result row. Pass `passed` (true/false) or `result` ('pass', 'fail', 'na').
 * Throws for a check that is not in the catalogue, so every check ID in the results is documented.
 */
export function checkResult(repo, check, catalogue, { passed, result, reason, details = [] }) {
  const entry = catalogue[check];
  if (!entry) throw new Error(`Check ${check} is not in the catalogue`);
  const value = result ?? (passed ? 'pass' : 'fail');
  if (!RESULTS.includes(value)) throw new Error(`Invalid result '${value}' for ${check}`);
  return { repo, check, name: entry.name, result: value, score: null, reason, details };
}

/** Skipped entries for a list of repositories that share one reason. */
export function skippedRepos(repos, reason) {
  return repos.map(repo => ({ repo: repo.name, reason }));
}

/** The complete tool file: header, results, catalogue, skipped and errors (always present). */
export function buildJsonDocument(header, { results, catalogue, skipped = [], errors = [] }) {
  return { ...header, results, catalogue, skipped, errors };
}

/** Writes the document as pretty-printed JSON, creating the directory if needed. */
export async function writeJsonReport(file, doc) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}
