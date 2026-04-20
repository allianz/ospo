#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import yaml from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(__dirname, '..');
const defaultConfigPath = path.join(repoRoot, 'config', 'archive_repos.yaml');

// ── Constants ────────────────────────────────────────────────────────────────

const ISSUE_TITLE = 'Inactive Repository Reminder';

function buildIssueBody(gracePeriod) {
  return `Dear Maintainers,

This repository has had no activity for an extended period. Inactive repositories tend to accumulate outdated dependencies and security vulnerabilities over time. To prevent this, this repository will be archived if no action is taken within the next ${gracePeriod}.

**What you can do:**
- Review and update dependencies
- Address any open Dependabot or security alerts
- If the project is stable and needs no changes, push an empty commit to confirm continued ownership:
  \`\`\`bash
  git commit --allow-empty -m "Keep repository active"
  \`\`\`

**Request for Unarchival:**
In case the repository is archived and there's a legitimate reason to revive it, please contact ospo@allianz.com with your request for unarchiving.

Best regards,

OSPO Team`;
}

// ── Date parsing ─────────────────────────────────────────────────────────────

export function parseRelativeDate(str) {
  const match = str.match(/^(\d+)\s+(minutes?|days?|months?|years?)(\s+ago)?$/);
  if (!match) {
    throw new Error(`Invalid relative date: "${str}". Expected format: "<N> <unit>" (e.g. "2 years")`);
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const date = new Date();
  if (unit.startsWith('minute')) {
    date.setUTCMinutes(date.getUTCMinutes() - n);
  } else if (unit.startsWith('day')) {
    date.setUTCDate(date.getUTCDate() - n);
  } else if (unit.startsWith('month')) {
    date.setUTCMonth(date.getUTCMonth() - n);
  } else if (unit.startsWith('year')) {
    date.setUTCFullYear(date.getUTCFullYear() - n);
  }
  return date;
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf8');
  const config = yaml.load(raw);
  if (!config.warn_after) {
    throw new Error(`Config missing required field: warn_after (in ${configPath})`);
  }
  if (!config.grace_period) {
    throw new Error(`Config missing required field: grace_period (in ${configPath})`);
  }
  // Validate date formats by parsing them
  parseRelativeDate(config.warn_after);
  parseRelativeDate(config.grace_period);
  config.excluded_repos = config.excluded_repos ?? [];
  return config;
}

// ── Issue helpers ────────────────────────────────────────────────────────────

async function findOpenIssue(octokit, org, repo, issueTitle) {
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: org,
    repo,
    state: 'open',
  });
  return issues.find(i => i.title === issueTitle) ?? null;
}

async function createIssue(octokit, org, repo, title, body) {
  await octokit.rest.issues.create({ owner: org, repo, title, body });
}

async function closeIssue(octokit, org, repo, issueNumber) {
  await octokit.rest.issues.update({
    owner: org,
    repo,
    issue_number: issueNumber,
    state: 'closed',
  });
}

// ── Core logic ───────────────────────────────────────────────────────────────

export async function processRepos(octokit, org, repos, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const { staleCutoff, graceCutoff, gracePeriod } = config;
  const planned = [];
  const upcoming = [];
  const nextWarnings = [];

  console.log('READING REPOSITORIES...');

  for (const repo of repos) {
    const pushedAt = new Date(repo.pushed_at);

    if (pushedAt < staleCutoff) {
      console.log(`${org}/${repo.name} is stale.`);
      if (debug) {
        console.log(`  pushed_at: ${repo.pushed_at} (before ${staleCutoff.toISOString()})`);
      }

      const existingIssue = await findOpenIssue(octokit, org, repo.name, ISSUE_TITLE);
      let effectiveIssueDate;

      if (!existingIssue) {
        if (debug) console.log('  No warning issue found.');
        if (dryRun) {
          planned.push(`Would create an issue for '${org}/${repo.name}'.`);
        } else {
          await createIssue(octokit, org, repo.name, ISSUE_TITLE, buildIssueBody(gracePeriod));
          console.log('  Created warning issue.');
        }
        effectiveIssueDate = new Date();
      } else {
        effectiveIssueDate = new Date(existingIssue.created_at);
        if (debug) {
          console.log(`  Warning issue #${existingIssue.number} created on ${existingIssue.created_at}`);
        }
      }

      if (effectiveIssueDate < graceCutoff) {
        if (dryRun) {
          planned.push(`Would archive repository '${org}/${repo.name}'.`);
        } else {
          await octokit.rest.repos.update({ owner: org, repo: repo.name, archived: true });
          console.log(`  Archived the repository '${org}/${repo.name}'.`);
        }
      } else {
        const msLeft = effectiveIssueDate.getTime() - graceCutoff.getTime();
        const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
        upcoming.push({ repo: repo.name, daysLeft });
        if (!dryRun) console.log(`  ${org}/${repo.name} has remaining grace period.`);
      }
    } else {
      if (debug) {
        console.log(`${org}/${repo.name} — pushed_at: ${repo.pushed_at} (not stale)`);
      }
      const existingIssue = await findOpenIssue(octokit, org, repo.name, ISSUE_TITLE);
      if (existingIssue) {
        if (dryRun) {
          planned.push(`Would close the existing issue in '${org}/${repo.name}'.`);
        } else {
          await closeIssue(octokit, org, repo.name, existingIssue.number);
          console.log(`  Closed the existing issue in the repository '${org}/${repo.name}'.`);
        }
      } else {
        const daysUntilWarning = Math.ceil((pushedAt.getTime() - staleCutoff.getTime()) / (1000 * 60 * 60 * 24));
        nextWarnings.push({ repo: repo.name, daysUntilWarning });
      }
    }

    if (!dryRun) console.log('');
  }

  upcoming.sort((a, b) => a.daysLeft - b.daysLeft);
  nextWarnings.sort((a, b) => a.daysUntilWarning - b.daysUntilWarning);

  return { planned, upcoming, nextWarnings: nextWarnings.slice(0, 3) };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let org = null;
  let configPath = defaultConfigPath;
  let dryRun = false;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        org = args[++i];
        break;
      case '--config':
        configPath = path.resolve(args[++i]);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--debug':
        debug = true;
        break;
    }
  }

  if (!org) {
    console.error('Error: --org is required');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN (or GH_TOKEN) environment variable is not set');
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const octokit = new Octokit({ auth: token });

  const staleCutoff = parseRelativeDate(config.warn_after);
  const graceCutoff = parseRelativeDate(config.grace_period);

  if (debug) {
    console.log(`Stale period cutoff: ${staleCutoff.toISOString()}`);
    console.log(`Grace period cutoff: ${graceCutoff.toISOString()}`);
  }

  const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
  });

  const excluded = new Set(config.excluded_repos);
  const candidates = allRepos
    .filter(r => !r.archived && !excluded.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (debug) {
    const excludedNames = allRepos.filter(r => excluded.has(r.name)).map(r => r.name);
    console.log(`Repos to process: ${candidates.map(r => r.name).join(', ')}`);
    if (excludedNames.length > 0) {
      console.log(`Excluded repos: ${excludedNames.join(', ')}`);
    }
    console.log('');
  }

  const { planned, upcoming, nextWarnings } = await processRepos(octokit, org, candidates, { staleCutoff, graceCutoff, gracePeriod: config.grace_period }, { dryRun, debug });

  if (dryRun && planned.length > 0) {
    console.log('\nPlanned changes:');
    for (const msg of planned) {
      console.log(`  ${msg}`);
    }
  }

  if (upcoming.length > 0) {
    const maxName = Math.max(...upcoming.map(u => u.repo.length));
    console.log('\nUpcoming archival:');
    for (const { repo, daysLeft } of upcoming) {
      const label = daysLeft <= 1 ? `${daysLeft} day left` : `${daysLeft} days left`;
      console.log(`  ${repo.padEnd(maxName)}  ${label}`);
    }
  }

  if (nextWarnings.length > 0) {
    const maxName = Math.max(...nextWarnings.map(u => u.repo.length));
    console.log('\nNext warning issues (top 3):');
    for (const { repo, daysUntilWarning } of nextWarnings) {
      const label = daysUntilWarning <= 1 ? `in ${daysUntilWarning} day` : `in ${daysUntilWarning} days`;
      console.log(`  ${repo.padEnd(maxName)}  ${label}`);
    }
  }

  if (planned.length === 0 && upcoming.length === 0) {
    console.log('\nNo changes needed.');
  }
}

// Only run main() when this file is the entry point (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
