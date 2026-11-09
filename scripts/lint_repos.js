#!/usr/bin/env node

import { simpleGit } from 'simple-git';
import { readFile, readdir, access, rm } from 'node:fs/promises';
import path from 'node:path';

import { parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { defaultConfigPath, loadYaml, repoRoot, requireFields } from './lib/config.js';
import { createGitHub, createOctokit } from './lib/github.js';
import { syncIssue } from './lib/issues.js';
import { buildHeader, buildJsonDocument, checkResult, skippedRepos, specCatalogue, writeJsonReport } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';
import { createPlan } from './lib/plan.js';
import { printHeading, printIssueDryRunSummary, printNameList, printSection } from './lib/report.js';
import { partitionRepos } from './lib/repos.js';

export const LINT_CACHE_DIR = path.join(repoRoot, 'lint_cache');
const CLONE_CONCURRENCY = 5;
const CLOSE_COMMENT = '_All compliance checks now pass. Closing this issue automatically._';
export const TOOL = 'lint_repos';
const SPEC_FILE = 'lint_repos_spec.md';
const MAX_TOPICS = 5;

// ── Config ────────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const config = await loadYaml(configPath);
  requireFields(config, ['issue_title'], configPath);
  config.allowed_topics = config.allowed_topics ?? [];
  config.allowed_licenses = config.allowed_licenses ?? [];
  config.required_files = config.required_files ?? [];
  config.forbidden_files = config.forbidden_files ?? [];
  config.excluded_repos = config.excluded_repos ?? [];
  config.description_length = {
    min: config.description_length?.min ?? 30,
    max: config.description_length?.max ?? 150,
  };
  const ids = new Set();
  validateFileSpecs(config.required_files, 'required_files', requiredFileCheckId, ids, configPath);
  validateFileSpecs(config.forbidden_files, 'forbidden_files', forbiddenFileCheckId, ids, configPath);
  return config;
}

/** Validates the entries of `required_files` or `forbidden_files`; `ids` collects the check IDs across both lists. */
function validateFileSpecs(fileSpecs, key, checkId, ids, configPath) {
  for (const fileSpec of fileSpecs) {
    const { pattern } = fileSpec;
    const valid = typeof pattern === 'string' || (Array.isArray(pattern) && pattern.length > 0 && pattern.every(p => typeof p === 'string'));
    if (!valid) {
      throw new Error(`${key} pattern must be a string or a non-empty list of strings (in ${configPath})`);
    }
    const id = checkId(fileSpec);
    if (fileSlug(fileSpec) === '' || ids.has(id)) {
      throw new Error(`${key} pattern '${patternText(fileSpec)}' gives no unique check ID (in ${configPath})`);
    }
    ids.add(id);
    if (fileSpec.json_only !== undefined && typeof fileSpec.json_only !== 'boolean') {
      throw new Error(`${key} pattern '${patternText(fileSpec)}': json_only must be true or false (in ${configPath})`);
    }
    if (typeof fileSpec.why !== 'string' || fileSpec.why.trim() === '') {
      throw new Error(`${key} pattern '${patternText(fileSpec)}': why must be a non-empty text (in ${configPath})`);
    }
  }
}

/** The patterns of a required file: `pattern` is one prefix glob or a list of them. */
export const filePatterns = fileSpec => [fileSpec.pattern].flat();

/** The patterns for people: "DEVELOPMENT* or DEVELOPER*". */
const patternText = fileSpec => filePatterns(fileSpec).join(' or ');

/** The part of a prefix glob before the first `*`: README* → README. */
const globPrefix = pattern => pattern.replace(/\*.*$/, '');

/** The pattern prefix of a file entry as a check ID part: CODE_OF_CONDUCT* → code-of-conduct. */
const fileSlug = fileSpec => globPrefix(filePatterns(fileSpec)[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Check ID of a required file, from the prefix of its (first) pattern: CONTRIBUTING* → lint/contributing. */
export const requiredFileCheckId = fileSpec => `lint/${fileSlug(fileSpec)}`;

/** Check ID of a forbidden file: CODE_OF_CONDUCT* → lint/no-code-of-conduct. */
export const forbiddenFileCheckId = fileSpec => `lint/no-${fileSlug(fileSpec)}`;

// ── Check functions ───────────────────────────────────────────────────────────

/** Why a metadata check matters, one text per failure case; shown in the issue below the finding. */
export const WHY = {
  descriptionMissing: 'GitHub shows the description, not the README, in the search results and in the GitHub CLI, so without it people cannot see what the project does.',
  descriptionShort: 'A description of a few words does not tell people what the project does. Describe its purpose in one full sentence.',
  descriptionLong: 'GitHub cuts long descriptions in the search results and in the CLI, so the end of the text is not shown.',
  topicsMissing: 'Topics are used to filter the projects of the organisation and for statistics across it. A repository without topics shows up in neither.',
  topicsTooMany: 'With too many topics a project shows up under filters that hardly apply to it. Choose the topics that describe it best.',
  topicsInvalid: 'Filtering and statistics only work properly if all projects use topics from a common taxonomy. With a topic outside the approved list (e.g. "k8s" instead of "kubernetes"), the project does not show up in the result lists.',
  licenseMissing: 'Without a license nobody may legally use, change or share the code, even though the repository is public.',
  licenseUnidentified: 'GitHub cannot show the license, so users and tools cannot see the terms. This happens when the license text was changed or combined with other text.',
  licenseNotApproved: 'Only the approved licenses may be used for Allianz open source projects.',
};

export function checkDescription(repo, descriptionLength) {
  const desc = repo.description?.trim() ?? '';
  if (desc.length === 0) {
    return { passed: false, detail: 'No description set', why: WHY.descriptionMissing };
  }
  if (desc.length < descriptionLength.min) {
    return { passed: false, detail: `Description too short (${desc.length} chars); minimum is ${descriptionLength.min}`, why: WHY.descriptionShort };
  }
  if (desc.length > descriptionLength.max) {
    return { passed: false, detail: `Description too long (${desc.length} chars); maximum is ${descriptionLength.max}`, why: WHY.descriptionLong };
  }
  return { passed: true, detail: `Description has ${desc.length} chars` };
}

export function checkTopics(repo, allowedTopics) {
  const topics = repo.topics ?? [];
  if (topics.length === 0) {
    return { passed: false, detail: 'No topics set', why: WHY.topicsMissing };
  }
  if (topics.length > MAX_TOPICS) {
    return { passed: false, detail: `Too many topics (${topics.length}); maximum is ${MAX_TOPICS}`, why: WHY.topicsTooMany };
  }
  if (allowedTopics.length > 0) {
    const invalid = topics.filter(t => !allowedTopics.includes(t));
    if (invalid.length > 0) {
      return { passed: false, detail: `Invalid topic(s): ${invalid.join(', ')}`, why: WHY.topicsInvalid };
    }
  }
  return { passed: true, detail: `Topics: ${topics.join(', ')}` };
}

export function checkLicense(repo, allowedLicenses) {
  const spdxId = repo.license?.spdx_id ?? null;
  if (spdxId === null) {
    return { passed: false, detail: 'No license detected', why: WHY.licenseMissing };
  }
  if (spdxId === 'NOASSERTION') {
    return {
      passed: false,
      detail: 'Custom license text detected — GitHub could not identify a standard SPDX license. Ensure the license is based on an approved one.',
      why: WHY.licenseUnidentified,
    };
  }
  if (!allowedLicenses.includes(spdxId)) {
    return { passed: false, detail: `'${spdxId}' is not in the approved list`, why: WHY.licenseNotApproved };
  }
  return { passed: true, detail: `'${spdxId}' is in the approved list` };
}

export function checkPublic(repo) {
  if (repo.visibility === 'public') {
    return { passed: true, detail: 'Repository is public' };
  }
  return { passed: false, detail: `Repository visibility is ${repo.visibility ?? 'unknown'}` };
}

export function checkIssuesEnabled(repo) {
  if (repo.has_issues === true) {
    return { passed: true, detail: 'Issues are enabled' };
  }
  return { passed: false, detail: 'Issues are disabled' };
}

/**
 * The files matching a file entry, in the order of its search paths: [{ searchPath, dir, name }].
 * Patterns are always prefix globs (README*, CONTRIBUTING*, LICENSE*) — matched case-insensitively.
 * A search path that does not exist is skipped.
 */
async function findFiles(cloneDir, fileSpec) {
  const prefixes = filePatterns(fileSpec).map(p => globPrefix(p).toUpperCase());
  const found = [];
  for (const searchPath of searchPathsOf(fileSpec)) {
    const dir = path.join(cloneDir, searchPath);
    const entries = await readdir(dir).catch(() => []);
    for (const name of entries.filter(f => prefixes.some(prefix => f.toUpperCase().startsWith(prefix)))) {
      found.push({ searchPath, dir, name });
    }
  }
  return found;
}

const searchPathsOf = fileSpec => fileSpec.search_paths ?? ['.'];

/** A found file for people: "NOTICE" in the root, "docs/DEVELOPMENT.md" elsewhere. */
const foundPath = ({ searchPath, name }) => (searchPath === '.' ? name : `${searchPath}/${name}`);

export async function checkRequiredFile(cloneDir, fileSpec) {
  const { min_chars } = fileSpec;
  const [match] = await findFiles(cloneDir, fileSpec);
  if (!match) {
    return { passed: false, detail: `File not found in ${searchPathsOf(fileSpec).join(', ')}` };
  }
  const found = match.searchPath === '.' ? `${match.name} found` : `${match.name} found in ${match.searchPath}`;
  if (min_chars != null) {
    const content = await readFile(path.join(match.dir, match.name), 'utf8');
    if (content.length < min_chars) {
      return { passed: false, detail: `File exists but is too short (${content.length} chars; minimum is ${min_chars})` };
    }
    return { passed: true, detail: `${found} (${content.length} chars)` };
  }
  return { passed: true, detail: found };
}

/** Passes when no file of the entry exists in any of its search paths; a failure lists every file found. */
export async function checkForbiddenFile(cloneDir, fileSpec) {
  const found = await findFiles(cloneDir, fileSpec);
  if (found.length === 0) {
    return { passed: true, detail: `No ${patternText(fileSpec)} file in ${searchPathsOf(fileSpec).join(', ')}` };
  }
  const them = found.length === 1 ? 'it' : 'them';
  return { passed: false, detail: `${found.map(foundPath).join(', ')} must not exist; delete ${them}` };
}

/** Checks that only need the repository metadata from the API (also run for archived repos). */
export function metadataChecks(repo, config) {
  return [
    { id: 'lint/description', checkName: 'Repository Description', ...checkDescription(repo, config.description_length) },
    { id: 'lint/topics', checkName: 'Repository Topics', ...checkTopics(repo, config.allowed_topics) },
    { id: 'lint/license-type', checkName: 'License Type', ...checkLicense(repo, config.allowed_licenses) },
  ];
}

/**
 * Checks that are written to the JSON file only (`jsonOnly`): they are not listed in the issue or the result line.
 * Project teams have no influence on them (visibility and issues are controlled centrally),
 * so an issue would be no use to them; the results are evidence for the compliance report and audits.
 */
export function jsonOnlyChecks(repo) {
  return [
    { id: 'lint/public', checkName: 'Public Repository', jsonOnly: true, ...checkPublic(repo) },
    { id: 'lint/issues-enabled', checkName: 'Issues Enabled', jsonOnly: true, ...checkIssuesEnabled(repo) },
  ];
}

/**
 * All checks for an active repository: metadata, the JSON-only checks and the required and forbidden files in its clone.
 * A file entry with `json_only: true` is JSON only as well.
 */
export async function runChecks(repo, config, cloneDir) {
  const checks = [...metadataChecks(repo, config), ...jsonOnlyChecks(repo)];
  for (const fileSpec of config.required_files) {
    checks.push({
      id: requiredFileCheckId(fileSpec),
      checkName: requiredFileName(fileSpec),
      jsonOnly: fileSpec.json_only === true,
      why: fileSpec.why,
      ...(await checkRequiredFile(cloneDir, fileSpec)),
    });
  }
  for (const fileSpec of config.forbidden_files) {
    checks.push({
      id: forbiddenFileCheckId(fileSpec),
      checkName: forbiddenFileName(fileSpec),
      jsonOnly: fileSpec.json_only === true,
      why: fileSpec.why,
      ...(await checkForbiddenFile(cloneDir, fileSpec)),
    });
  }
  return checks;
}

const requiredFileName = fileSpec => fileSpec.description ?? patternText(fileSpec);
const forbiddenFileName = fileSpec => fileSpec.description ?? `No ${patternText(fileSpec)}`;

// ── JSON output ───────────────────────────────────────────────────────────────

/** Catalogue of every check this run performs, with the rule texts built from the configuration. */
export function buildCatalogue(config, { sha = null, env = {} } = {}) {
  const entry = specCatalogue(SPEC_FILE, { sha, env });
  const { min, max } = config.description_length;
  const approved = config.allowed_topics.length > 0;
  const licenses = config.allowed_licenses.join(', ');
  const catalogue = {
    'lint/description': entry(
      'Repository Description',
      `The repository description is set and has ${min} to ${max} characters.`,
      `Set a description of ${min} to ${max} characters in the About section of the repository.`,
    ),
    'lint/topics': entry(
      'Repository Topics',
      `The repository has 1 to ${MAX_TOPICS} topics${approved ? ', all from the approved topic list' : ''}.`,
      `Add 1 to ${MAX_TOPICS} topics${approved ? ' from the approved topic list' : ''} in the About section of the repository.`,
    ),
    'lint/license-type': entry(
      'License Type',
      `The license GitHub detects is one of ${licenses}. A missing or unidentified license (NOASSERTION) fails.`,
      `Use one of the approved licenses (${licenses}) with its unmodified license text, so GitHub can detect it.`,
    ),
    'lint/public': entry(
      'Public Repository',
      'The repository is public.',
      'Not fixable by the project team: the OSPO makes the repository public or archives it.',
    ),
    'lint/issues-enabled': entry(
      'Issues Enabled',
      'Issues are enabled for the repository.',
      'Not fixable by the project team: the OSPO enables Issues for the repository.',
    ),
  };
  for (const fileSpec of config.required_files) {
    const paths = searchPathsOf(fileSpec).join(', ');
    const size = fileSpec.min_chars != null ? `, with at least ${fileSpec.min_chars} characters` : '';
    catalogue[requiredFileCheckId(fileSpec)] = entry(
      requiredFileName(fileSpec),
      `A file ${patternText(fileSpec)} exists in ${paths}${size}.`,
      `Add a ${patternText(fileSpec)} file in ${paths}${size}.`,
    );
  }
  for (const fileSpec of config.forbidden_files) {
    const paths = searchPathsOf(fileSpec).join(', ');
    catalogue[forbiddenFileCheckId(fileSpec)] = entry(
      forbiddenFileName(fileSpec),
      `No file ${patternText(fileSpec)} exists in ${paths}.`,
      `Delete the ${patternText(fileSpec)} file from ${paths}.`,
    );
  }
  return catalogue;
}

/** Results of the active repositories and the skipped list (archived and excluded repositories have no results). */
export function buildJsonResults({ checked, archived, excluded, catalogue }) {
  return {
    results: checked.flatMap(({ repo, checks }) =>
      checks.map(c => checkResult(repo, c.id, catalogue, { passed: c.passed, reason: c.detail })),
    ),
    skipped: [...skippedRepos(archived, 'archived'), ...skippedRepos(excluded, 'excluded_repos')],
  };
}

// ── Issue body ────────────────────────────────────────────────────────────────

/** Text for one table cell: on one line, `|` escaped so it cannot end the cell, `<` and `>` so GitHub does not take them for HTML. */
const tableCell = text => text.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The Details cell of a failed check: the finding, and below it why the check matters. */
function failureCell({ detail, why }) {
  const finding = tableCell(detail ?? '');
  return why ? `${finding}<br>**Why:** ${tableCell(why)}` : finding;
}

export function buildIssueBody(allChecks, docsLink) {
  const rows = allChecks.map(check => {
    const icon = check.passed ? '✅' : '❌';
    const status = check.passed ? 'Passed' : 'Failed';
    return `| ${check.checkName} | ${icon} ${status} | ${check.passed ? '' : failureCell(check)} |`;
  });
  return [
    '## Mandatory Repository Configuration',
    '',
    'The following compliance checks failed for this repository:',
    '',
    '| Check | Status | Details |',
    '|-------|--------|---------|',
    ...rows,
    '',
    `Please review the [Mandatory Repository Configuration](${docsLink}) guide and address the issues above.`,
    '',
    '_This issue was automatically generated by the OSPO linting bot._',
  ].join('\n');
}

// ── Cloning ───────────────────────────────────────────────────────────────────

const exists = async dir => access(dir).then(() => true, () => false);

/** Shallow-clones the repository into cloneDir, or updates an existing clone (re-cloning if that fails). */
export async function cloneOrUpdate(repoName, cloneDir, org, { git = simpleGit, logger } = {}) {
  const url = `https://github.com/${org}/${repoName}.git`;
  const alreadyCloned = await exists(cloneDir);
  logger?.debug(`  ${alreadyCloned ? 'Updating' : 'Cloning'} ${repoName}...`);
  if (!alreadyCloned) {
    await git().clone(url, cloneDir, ['--depth', '1']);
    return;
  }
  try {
    const repo = git(cloneDir);
    await repo.fetch(['origin', '--depth', '1']);
    try {
      await repo.reset(['--hard', 'FETCH_HEAD']);
    } catch {
      // FETCH_HEAD not set — repo is empty on remote, nothing to reset to
    }
  } catch {
    // Stale or corrupt clone — delete and re-clone from scratch
    logger?.debug(`  Re-cloning ${repoName} (update failed)...`);
    await rm(cloneDir, { recursive: true, force: true });
    await git().clone(url, cloneDir, ['--depth', '1']);
  }
}

// ── Output helpers ────────────────────────────────────────────────────────────

export function formatResultLine(repoName, failures, isArchived) {
  const passIcon = isArchived ? '✔️' : '✅';
  const failIcon = isArchived ? '✖️' : '❌';
  if (failures.length === 0) {
    return `${passIcon} ${repoName}`;
  }
  const names = failures.map(f => f.checkName).join(', ');
  return `${failIcon} ${repoName}  [${names}]`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger, github, git, cacheDir = LINT_CACHE_DIR, now = new Date() } = {}) {
  const { org, configPath, dryRun, debug, json } = parseCli(argv, { defaultConfigPath: defaultConfigPath(TOOL), stringFlags: ['json'] });
  const gh = github ?? createGitHub(createOctokit(resolveToken(env)));
  const log = logger ?? createLogger({ debug });
  const config = await loadConfig(configPath);
  const plan = createPlan({ dryRun, logger: log });

  const { active, archived, excluded } = partitionRepos(await gh.listOrgRepos(org, { type: 'all' }), config.excluded_repos);

  if (active.length > 0) {
    log.debug(`Cloning ${active.length} repositories (${CLONE_CONCURRENCY} at a time)...`);
    await mapWithConcurrency(active, CLONE_CONCURRENCY, repo =>
      cloneOrUpdate(repo.name, path.join(cacheDir, repo.name), org, { git, logger: log }),
    );
    log.debug('');
  }

  printHeading(log, 'Results');

  const checked = [];
  for (const repo of active) {
    const checks = await runChecks(repo, config, path.join(cacheDir, repo.name));
    checked.push({ repo: repo.name, checks });
    const issueChecks = checks.filter(c => !c.jsonOnly);
    const failures = issueChecks.filter(c => !c.passed);

    log.info(formatResultLine(repo.name, failures, false));
    for (const f of failures) log.debug(`     ${f.checkName}: ${f.detail}`);

    if (repo.has_issues !== true) {
      if (failures.length > 0) log.info(`⚠️  ${repo.name}: issues are disabled, no issue opened`);
      continue;
    }
    await syncIssue(gh, plan, {
      org,
      repo: repo.name,
      title: config.issue_title,
      body: buildIssueBody(issueChecks, config.docs_link),
      wanted: failures.length > 0,
      closeComment: CLOSE_COMMENT,
    });
  }

  printSection(log, 'Skipped (archived)', archived.map(repo =>
    formatResultLine(repo.name, metadataChecks(repo, config).filter(c => !c.passed), true),
  ));
  printNameList(log, 'Skipped (configuration)', excluded.map(r => r.name));
  printIssueDryRunSummary(log, plan);

  if (json) {
    const header = await buildHeader({ tool: TOOL, org, configPath, issueTitle: config.issue_title, env, now, git });
    const catalogue = buildCatalogue(config, { sha: header.ospo_sha, env });
    const doc = buildJsonDocument(header, { catalogue, ...buildJsonResults({ checked, archived, excluded, catalogue }) });
    await writeJsonReport(path.resolve(json), doc);
    log.info(`\nJSON written to ${json}`);
  }
  return 0;
}

runIfMain(import.meta.url, run);
