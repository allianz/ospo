#!/usr/bin/env node

import simpleGit from 'simple-git';
import { readFile, readdir, access, rm } from 'node:fs/promises';
import path from 'node:path';

import { parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { defaultConfigPath, loadYaml, repoRoot, requireFields } from './lib/config.js';
import { createGitHub, createOctokit } from './lib/github.js';
import { syncIssue } from './lib/issues.js';
import { createLogger } from './lib/logger.js';
import { createPlan } from './lib/plan.js';
import { printHeading, printIssueDryRunSummary, printNameList, printSection } from './lib/report.js';
import { partitionRepos } from './lib/repos.js';

export const LINT_CACHE_DIR = path.join(repoRoot, 'lint_cache');
const CLONE_CONCURRENCY = 5;
const CLOSE_COMMENT = '_All compliance checks now pass. Closing this issue automatically._';

// ── Config ────────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const config = await loadYaml(configPath);
  requireFields(config, ['issue_title'], configPath);
  config.allowed_topics = config.allowed_topics ?? [];
  config.allowed_licenses = config.allowed_licenses ?? [];
  config.required_files = config.required_files ?? [];
  config.excluded_repos = config.excluded_repos ?? [];
  config.description_length = {
    min: config.description_length?.min ?? 30,
    max: config.description_length?.max ?? 150,
  };
  return config;
}

// ── Check functions ───────────────────────────────────────────────────────────

export function checkDescription(repo, descriptionLength) {
  const desc = repo.description?.trim() ?? '';
  if (desc.length === 0) {
    return { passed: false, detail: 'No description set' };
  }
  if (desc.length < descriptionLength.min) {
    return { passed: false, detail: `Description too short (${desc.length} chars); minimum is ${descriptionLength.min}` };
  }
  if (desc.length > descriptionLength.max) {
    return { passed: false, detail: `Description too long (${desc.length} chars); maximum is ${descriptionLength.max}` };
  }
  return { passed: true };
}

export function checkTopics(repo, allowedTopics) {
  const topics = repo.topics ?? [];
  if (topics.length === 0) {
    return { passed: false, detail: 'No topics set' };
  }
  if (topics.length > 5) {
    return { passed: false, detail: `Too many topics (${topics.length}); maximum is 5` };
  }
  if (allowedTopics.length > 0) {
    const invalid = topics.filter(t => !allowedTopics.includes(t));
    if (invalid.length > 0) {
      return { passed: false, detail: `Invalid topic(s): ${invalid.join(', ')}` };
    }
  }
  return { passed: true };
}

export function checkLicense(repo, allowedLicenses) {
  const spdxId = repo.license?.spdx_id ?? null;
  if (spdxId === null) {
    return { passed: false, detail: 'No license detected' };
  }
  if (spdxId === 'NOASSERTION') {
    return {
      passed: false,
      detail: 'Custom license text detected — GitHub could not identify a standard SPDX license. Ensure the license is based on an approved one.',
    };
  }
  if (!allowedLicenses.includes(spdxId)) {
    return { passed: false, detail: `'${spdxId}' is not in the approved list` };
  }
  return { passed: true };
}

export async function checkRequiredFile(cloneDir, fileSpec) {
  const { pattern, search_paths, min_chars } = fileSpec;
  const searchPaths = search_paths ?? ['.'];
  // Patterns are always prefix globs (README*, CONTRIBUTING*, LICENSE*) — match case-insensitively
  const prefix = pattern.replace(/\*.*$/, '').toUpperCase();
  for (const searchPath of searchPaths) {
    const dir = path.join(cloneDir, searchPath);
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue; // Directory doesn't exist — try next path
    }
    const match = entries.find(f => f.toUpperCase().startsWith(prefix));
    if (!match) continue;
    if (min_chars != null) {
      const content = await readFile(path.join(dir, match), 'utf8');
      if (content.length < min_chars) {
        return { passed: false, detail: `File exists but is too short (${content.length} chars; minimum is ${min_chars})` };
      }
    }
    return { passed: true };
  }
  return { passed: false, detail: `File not found in ${searchPaths.join(', ')}` };
}

/** Checks that only need the repository metadata from the API (also run for archived repos). */
export function metadataChecks(repo, config) {
  return [
    { checkName: 'Repository Description', ...checkDescription(repo, config.description_length) },
    { checkName: 'Repository Topics', ...checkTopics(repo, config.allowed_topics) },
    { checkName: 'License Type', ...checkLicense(repo, config.allowed_licenses) },
  ];
}

/** All checks for an active repository: metadata plus the required files in its clone. */
export async function runChecks(repo, config, cloneDir) {
  const checks = metadataChecks(repo, config);
  for (const fileSpec of config.required_files) {
    checks.push({ checkName: fileSpec.description ?? fileSpec.pattern, ...(await checkRequiredFile(cloneDir, fileSpec)) });
  }
  return checks;
}

// ── Issue body ────────────────────────────────────────────────────────────────

export function buildIssueBody(allChecks, docsLink) {
  const rows = allChecks.map(({ checkName, passed, detail }) => {
    const icon = passed ? '✅' : '❌';
    const status = passed ? 'Passed' : 'Failed';
    const detailCell = passed ? '' : (detail ?? '');
    return `| ${checkName} | ${icon} ${status} | ${detailCell} |`;
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

export async function run({ argv = [], env = {}, logger, github, git, cacheDir = LINT_CACHE_DIR } = {}) {
  const { org, configPath, dryRun, debug } = parseCli(argv, { defaultConfigPath: defaultConfigPath('lint_repos') });
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

  for (const repo of active) {
    const checks = await runChecks(repo, config, path.join(cacheDir, repo.name));
    const failures = checks.filter(c => !c.passed);

    log.info(formatResultLine(repo.name, failures, false));
    for (const f of failures) log.debug(`     ${f.checkName}: ${f.detail}`);

    await syncIssue(gh, plan, {
      org,
      repo: repo.name,
      title: config.issue_title,
      body: buildIssueBody(checks, config.docs_link),
      wanted: failures.length > 0,
      closeComment: CLOSE_COMMENT,
    });
  }

  printSection(log, 'Skipped (archived)', archived.map(repo =>
    formatResultLine(repo.name, metadataChecks(repo, config).filter(c => !c.passed), true),
  ));
  printNameList(log, 'Skipped (configuration)', excluded.map(r => r.name));
  printIssueDryRunSummary(log, plan);
  return 0;
}

runIfMain(import.meta.url, run);
