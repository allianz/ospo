#!/usr/bin/env node

import { setTimeout as sleepMs } from 'node:timers/promises';

import { parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { defaultConfigPath, loadYaml, requireFields } from './lib/config.js';
import { API_VERSION, createGitHub, createOctokit } from './lib/github.js';
import { syncIssue, syncSummaryIssue } from './lib/issues.js';
import { createLogger } from './lib/logger.js';
import { createPlan } from './lib/plan.js';
import { printHeading, printIssueDryRunSummary, printNameList } from './lib/report.js';
import { partitionRepos } from './lib/repos.js';

const CONCURRENCY = 5;
export const OSPO_LICENSE_ISSUE_TITLE = 'License Violation Summary';
const CLOSE_COMMENT = '_All dependency license violations have been resolved. Closing this issue automatically._';

// ── Config ────────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const config = await loadYaml(configPath);
  requireFields(config, ['issue_title', 'deny-licenses'], configPath);
  config.excluded_repos = config.excluded_repos ?? [];
  config.docs_link = config.docs_link ?? '';
  return config;
}

// ── Check functions ───────────────────────────────────────────────────────────

/** The SPDX ID of a package, or null when the SBOM has no usable license information. */
export function licenseOf(pkg) {
  const spdxId = pkg.licenseConcluded ?? pkg.licenseDeclared ?? null;
  return !spdxId || spdxId === 'NOASSERTION' || spdxId === 'NONE' ? null : spdxId;
}

export function checkDependencyLicenses(packages, denyList) {
  return packages
    .filter(pkg => denyList.includes(licenseOf(pkg)))
    .map(pkg => ({ name: pkg.name ?? '', version: pkg.versionInfo ?? '', spdxId: licenseOf(pkg) }));
}

export function summarizeLicenses(packages) {
  const licenses = packages.map(licenseOf);
  return {
    packageCount: packages.length,
    uniqueLicenseCount: new Set(licenses.filter(Boolean)).size,
    noLicenseCount: licenses.filter(l => l === null).length,
  };
}

// ── SBOM fetching (async API) ─────────────────────────────────────────────────

export const SBOM_POLLING = { initialWaitMs: 400, pollDelayMs: 2000, maxPollAttempts: 10, maxServerErrors: 3 };

/**
 * Fetches the SBOM packages list for a repo. Throws on any failure — the
 * dependency graph cannot be disabled, so failures here are real errors.
 * `fetch` and `sleep` are injectable so tests don't hit the network or wait.
 */
export async function fetchSbomPackages(gh, org, repo, { token, fetch = globalThis.fetch, sleep = sleepMs, polling = SBOM_POLLING } = {}) {
  const { initialWaitMs, pollDelayMs, maxPollAttempts, maxServerErrors } = polling;
  const reportUrl = await gh.requestSbomReport(org, repo);
  if (!reportUrl) {
    throw new Error(`SBOM report URL missing for ${org}/${repo}`);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };

  // Poll the report URL until ready. Status codes from the SBOM API:
  //   302 → SBOM ready, follow the Location header to download
  //   202 → still generating, wait and retry
  //   5xx → transient server error, retry up to maxServerErrors times
  //   other → unexpected, abort
  await sleep(initialWaitMs);
  let serverErrors = 0;
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    const res = await fetch(reportUrl, { headers, redirect: 'manual' });

    if (res.status === 302) {
      const download = await fetch(res.headers.get('location'));
      if (!download.ok) {
        throw new Error(`SBOM download failed for ${org}/${repo}: status ${download.status}`);
      }
      const sbom = await download.json();
      return { packages: sbom?.packages ?? sbom?.sbom?.packages ?? [], pollAttempts: attempt };
    }

    if (res.status === 202) {
      await sleep(pollDelayMs);
      continue;
    }

    if (res.status >= 500) {
      serverErrors++;
      if (serverErrors >= maxServerErrors) {
        throw new Error(`SBOM polling failed for ${org}/${repo}: ${maxServerErrors} consecutive 5xx responses`);
      }
      await sleep(pollDelayMs);
      continue;
    }

    throw new Error(`SBOM polling failed for ${org}/${repo}: status ${res.status}`);
  }

  const totalSeconds = (maxPollAttempts * pollDelayMs) / 1000;
  throw new Error(`SBOM for ${org}/${repo} not ready after ${totalSeconds}s. Giving up.`);
}

const isMissingSbom = err => err.status === 404 || /404|Not Found/i.test(err.message);

// ── Issue bodies ──────────────────────────────────────────────────────────────

export function buildIssueBody(violations, config) {
  const rows = violations.map(({ name, version, spdxId }) => `| ${name} | ${version} | ${spdxId} |`);
  const policyLine = config.docs_link
    ? `Please review the [License Policy](${config.docs_link}) and replace or remove the dependencies above.`
    : 'Please replace or remove the dependencies above.';
  return [
    '## Dependency License Violation',
    '',
    'The following dependencies use licenses that are not permitted:',
    '',
    '| Package | Version | License |',
    '|---------|---------|---------|',
    ...rows,
    '',
    policyLine,
    '',
    '_This issue was automatically generated by the OSPO license scanner._',
  ].join('\n');
}

export function buildOspoLicenseIssueBody(repoViolations) {
  const rows = repoViolations.flatMap(({ repo, violations }) =>
    violations.map(({ name, version, spdxId }) => `| ${repo} | ${name} | ${version} | ${spdxId} |`),
  );
  return [
    '## License Violation Summary',
    '',
    'The following repositories contain dependencies with licenses that are not permitted. Please inform the repository owners.',
    '',
    '| Repository | Package | Version | License |',
    '|---|---|---|---|',
    ...rows,
    '',
    '_This issue was automatically generated by the OSPO license scanner._',
  ].join('\n');
}

// ── Output ────────────────────────────────────────────────────────────────────

const pad = name => (name.length >= 20 ? name.slice(0, 20) : name.padEnd(20));

export function formatRepoResult({ repo, summary, violations, pollAttempts, seconds }, { debug = false } = {}) {
  const icon = violations.length > 0 ? '❌' : '✅';
  const lines = [`${icon} ${pad(repo)}  ${summary.packageCount} packages, ${summary.uniqueLicenseCount} unique licenses`];
  if (debug && summary.noLicenseCount > 0) lines.push(`       No license info: ${summary.noLicenseCount} packages`);
  for (const v of violations) lines.push(`       Non-compliant: ${v.name}@${v.version} (${v.spdxId})`);
  if (debug) lines.push(`       Performance: ${pollAttempts} poll attempt(s), ${seconds.toFixed(1)}s total`);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger, github, fetch, sleep } = {}) {
  const { org, configPath, dryRun, debug } = parseCli(argv, { defaultConfigPath: defaultConfigPath('license_scan') });
  const token = resolveToken(env);
  const gh = github ?? createGitHub(createOctokit(token));
  const log = logger ?? createLogger({ debug });

  log.info(`Config: ${configPath}`);
  const config = await loadConfig(configPath);
  const plan = createPlan({ dryRun, logger: log });

  const { active, archived, excluded } = partitionRepos(await gh.listOrgRepos(org, { type: 'all' }), config.excluded_repos);

  log.info('');
  printHeading(log, 'Results');

  const repoViolations = [];
  const noSbom = [];

  await mapWithConcurrency(active, CONCURRENCY, async repo => {
    const t0 = performance.now();
    let sbom;
    try {
      sbom = await fetchSbomPackages(gh, org, repo.name, { token, fetch, sleep });
    } catch (err) {
      if (isMissingSbom(err)) {
        noSbom.push(repo.name);
        return;
      }
      throw err;
    }

    const violations = checkDependencyLicenses(sbom.packages, config['deny-licenses']);
    if (violations.length > 0) repoViolations.push({ repo: repo.name, violations });

    await syncIssue(gh, plan, {
      org,
      repo: repo.name,
      title: config.issue_title,
      body: buildIssueBody(violations, config),
      wanted: violations.length > 0,
      closeComment: CLOSE_COMMENT,
    });

    const result = {
      repo: repo.name,
      summary: summarizeLicenses(sbom.packages),
      violations,
      pollAttempts: sbom.pollAttempts,
      seconds: (performance.now() - t0) / 1000,
    };
    log.info(formatRepoResult(result, { debug }));
  });

  await syncSummaryIssue(gh, plan, {
    org,
    title: OSPO_LICENSE_ISSUE_TITLE,
    body: repoViolations.length > 0 ? buildOspoLicenseIssueBody(repoViolations) : null,
    closeComment: CLOSE_COMMENT,
    donePrefix: '\n',
  });

  printNameList(log, 'Skipped (archived)', archived.map(r => r.name));
  printNameList(log, 'Skipped (configuration)', excluded.map(r => r.name));
  printNameList(log, 'Skipped (no SBOM available)', noSbom);
  printIssueDryRunSummary(log, plan, { subject: 'issue' });
  return 0;
}

runIfMain(import.meta.url, run);
