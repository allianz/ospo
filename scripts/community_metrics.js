#!/usr/bin/env node

// Collects the community metrics of the previous calendar month for every public repository:
// stars, forks, contributors (internal / external), commits, pull requests, issues, releases and
// traffic, plus the totals of the organisation. Read-only: no issues, no writes to GitHub.
// The file holds counts only, no logins. See spec/community_metrics_spec.md.

import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { ScriptError, parseCli, resolveToken, runIfMain } from './lib/cli.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { defaultConfigPath, loadYaml } from './lib/config.js';
import { parseRelativeDate } from './lib/dates.js';
import { createGitHub, createOctokit } from './lib/github.js';
import { buildHeader, buildJsonDocument, writeJsonReport } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const TOOL = 'community_metrics';
const CONCURRENCY = 8;
/** GitHub computes the contributor statistics in the background (202): ask again after `delayMs`, at most `maxAttempts` times. */
export const STATS_POLLING = { delayMs: 3000, maxAttempts: 10 };
export const MILESTONE_METRICS = ['visitors', 'stars', 'public_projects', 'contributors', 'external_contributors'];
export const DEFAULTS = {
  excluded_repos: ['.github', 'ospo'],
  bots: [],
  active_within: '90 days',
  milestones: {
    visitors: [1000, 2500, 5000, 10000],
    stars: [1000, 2500, 5000, 10000],
    public_projects: [25, 50, 100],
    contributors: [100, 200, 500, 1000],
    external_contributors: [10, 25, 50, 100],
  },
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const num = n => (n == null ? '–' : n.toLocaleString('en'));
const plural = (n, singular, pluralForm = `${singular}s`) => `${num(n)} ${n === 1 ? singular : pluralForm}`;
const day = iso => iso.slice(0, 10);
const zero = () => ({ internal: 0, external: 0 });

// ── Config ───────────────────────────────────────────────────────────────────

function requireStrings(config, field, configPath) {
  const value = config[field];
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw new Error(`Config field ${field} must be a list of strings (in ${configPath})`);
  }
}

export async function loadConfig(configPath) {
  const loaded = (await loadYaml(configPath)) ?? {};
  const config = { ...DEFAULTS, ...loaded, milestones: { ...DEFAULTS.milestones, ...(loaded.milestones ?? {}) } };
  requireStrings(config, 'excluded_repos', configPath);
  requireStrings(config, 'bots', configPath);
  try {
    parseRelativeDate(config.active_within);
  } catch (error) {
    throw new Error(`Config field active_within: ${error.message} (in ${configPath})`);
  }
  if (typeof loaded.milestones !== 'undefined' && (typeof loaded.milestones !== 'object' || Array.isArray(loaded.milestones) || loaded.milestones === null)) {
    throw new Error(`Config field milestones must be a map of metric to levels (in ${configPath})`);
  }
  for (const [metric, levels] of Object.entries(config.milestones)) {
    if (!MILESTONE_METRICS.includes(metric)) {
      throw new Error(`Config field milestones.${metric} is not a metric (expected one of ${MILESTONE_METRICS.join(', ')}) (in ${configPath})`);
    }
    const valid = Array.isArray(levels) && levels.every((l, i) => Number.isInteger(l) && l > 0 && (i === 0 || l > levels[i - 1]));
    if (!valid) throw new Error(`Config field milestones.${metric} must be positive integers in increasing order (in ${configPath})`);
  }
  return config;
}

// ── Period and scope ─────────────────────────────────────────────────────────

/** The calendar month before the month of `now` (UTC): `{ month, from, to }`, `to` exclusive. */
export function periodOf(now) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const iso = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { month: iso(from).slice(0, 7), from: iso(from), to: iso(to) };
}

/** "October 2026 (2026-10-01 – 2026-10-31)" */
export function describePeriod(period) {
  const last = new Date(Date.parse(period.to) - 864e5).toISOString();
  return `${MONTHS[Number(period.month.slice(5, 7)) - 1]} ${period.month.slice(0, 4)} (${day(period.from)} – ${day(last)})`;
}

const inPeriod = (iso, period) => iso != null && iso >= period.from && iso < period.to;

/** Repositories in scope (public, not archived, not a fork, not excluded), sorted by name, and the skipped ones with their reason. */
export function scopeRepos(repos, excluded) {
  const excludedSet = new Set(excluded);
  const inScope = [];
  const skipped = [];
  for (const repo of repos) {
    let reason = null;
    if (excludedSet.has(repo.name)) reason = 'excluded_repos';
    else if (repo.private || (repo.visibility && repo.visibility !== 'public')) reason = 'private';
    else if (repo.archived) reason = 'archived';
    else if (repo.fork) reason = 'fork';
    if (reason) skipped.push({ repo: repo.name, reason });
    else inScope.push(repo);
  }
  const byName = (a, b) => a.localeCompare(b);
  return { inScope: inScope.sort((a, b) => byName(a.name, b.name)), skipped: skipped.sort((a, b) => byName(a.repo, b.repo)) };
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * Decides who counts and how: `login(user)` is the lower-case login, or null for a bot or a missing
 * account; `side(login)` is 'internal' for an org member, 'external' for everybody else.
 */
export function createPeople(members, bots) {
  const memberSet = new Set(members.map(m => m.toLowerCase()));
  const botSet = new Set(bots.map(b => b.toLowerCase()));
  return {
    login(user) {
      if (!user?.login) return null;
      const login = user.login.toLowerCase();
      if (user.type === 'Bot' || login.endsWith('[bot]') || botSet.has(login)) return null;
      return login;
    },
    side: login => (memberSet.has(login) ? 'internal' : 'external'),
  };
}

/** `{ internal, external }` of a set (or the keys of a map) of logins. */
export function countSides(logins, people) {
  const counts = zero();
  for (const login of logins) counts[people.side(login)]++;
  return counts;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * From the weekly contributor statistics: `authors` (login → first week with a commit, ISO), the
 * logins with a commit in the period and the commits in the period. A week belongs to the month in
 * which it starts. Bots and authors without an account are left out.
 */
export function contributorActivity(stats, period, people) {
  const authors = new Map();
  const active = new Set();
  let commits = 0;
  for (const entry of stats) {
    const login = people.login(entry.author);
    if (!login) continue;
    for (const week of entry.weeks ?? []) {
      if (!(week.c > 0)) continue;
      const start = new Date(week.w * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (!authors.has(login) || start < authors.get(login)) authors.set(login, start);
      if (inPeriod(start, period)) {
        active.add(login);
        commits += week.c;
      }
    }
  }
  return { authors, active, commits };
}

/**
 * Issues (not pull requests) and pull requests of the period, by internal / external author, and
 * the logins who opened one in the period. Bots are left out.
 */
export function issueActivity(issues, pulls, period, people) {
  const result = {
    prs: { opened: zero(), merged: zero(), closed_unmerged: zero() },
    issues: { opened: zero(), closed: zero() },
    openers: new Set(),
  };
  const count = (item, counts, field) => {
    const login = people.login(item.user);
    if (!login) return;
    if (inPeriod(item[field], period)) {
      counts[people.side(login)]++;
      if (field === 'created_at') result.openers.add(login);
    }
  };
  for (const issue of issues.filter(i => !i.pull_request)) {
    count(issue, result.issues.opened, 'created_at');
    count(issue, result.issues.closed, 'closed_at');
  }
  for (const pull of pulls) {
    count(pull, result.prs.opened, 'created_at');
    count(pull, result.prs.merged, 'merged_at');
    if (!pull.merged_at) count(pull, result.prs.closed_unmerged, 'closed_at');
  }
  return result;
}

/** The traffic of the last 14 days GitHub returned, with the first and last day of the window. */
export function trafficMetrics(views, clones) {
  const days = [...(views.views ?? []), ...(clones.clones ?? [])].map(d => day(d.timestamp)).sort();
  return {
    views: views.count ?? 0,
    visitors: views.uniques ?? 0,
    clones: clones.count ?? 0,
    cloners: clones.uniques ?? 0,
    from: days[0] ?? null,
    to: days.at(-1) ?? null,
  };
}

/** Published releases (drafts not counted): in the period (oldest first) and all-time, and the downloads of all their assets. */
export function releaseMetrics(releases, period) {
  const published = releases.filter(r => !r.draft && r.published_at);
  const inMonth = published.filter(r => inPeriod(r.published_at, period))
    .sort((a, b) => a.published_at.localeCompare(b.published_at));
  return {
    releases: { period: inMonth.length, total: published.length, tags: inMonth.map(r => r.tag_name) },
    release_downloads: published.flatMap(r => r.assets ?? []).reduce((sum, a) => sum + (a.download_count ?? 0), 0),
    list: inMonth.map(r => ({ tag: r.tag_name, date: day(r.published_at) })),
  };
}

// ── GitHub reads ─────────────────────────────────────────────────────────────

const STATUS_TEXT = { 403: 'missing permission', 404: 'not found or missing permission', 410: 'disabled' };

/** A request that failed with 403, 404 or 410 becomes an error message; everything else is thrown. */
async function readable(fn, what) {
  try {
    return { value: await fn() };
  } catch (error) {
    if (!STATUS_TEXT[error?.status]) throw error;
    return { error: `${what} not readable (request returned ${error.status}: ${STATUS_TEXT[error.status]})`, status: error.status };
  }
}

/** The contributor statistics, asking again while GitHub answers 202 (still computing). */
export async function fetchContributorStats(gh, org, repo, { sleep = sleepMs, polling = STATS_POLLING } = {}) {
  for (let attempt = 1; attempt <= polling.maxAttempts; attempt++) {
    const { status, data } = await gh.getContributorStats(org, repo);
    if (status !== 202) return { stats: data };
    if (attempt < polling.maxAttempts) await sleep(polling.delayMs);
  }
  return { error: `Contributor statistics not ready after ${polling.maxAttempts} attempts (GitHub is still computing them)` };
}

/** All metrics of one repository: the entry written to the file, the logins (kept in memory only), releases and errors. */
export async function collectRepo(gh, org, repo, { period, activeSince, people, sleep, polling }) {
  const errors = [];
  const fail = (metric, reason) => errors.push({ repo: repo.name, metric, reason });

  const stats = await readable(() => fetchContributorStats(gh, org, repo.name, { sleep, polling }), 'Contributor statistics');
  const statsError = stats.error ?? stats.value.error;
  if (statsError) fail('contributors', statsError);
  const commitPart = statsError ? null : contributorActivity(stats.value.stats, period, people);

  const issues = await readable(() => gh.listIssuesSince(org, repo.name, period.from), 'Issues');
  if (issues.error && issues.status !== 410) fail('issues', issues.error);
  const pulls = await readable(() => gh.listPullsUpdatedSince(org, repo.name, period.from), 'Pull requests');
  if (pulls.error) fail('prs', pulls.error);
  const activity = issueActivity(issues.value ?? [], pulls.value ?? [], period, people);
  const activityComplete = !(issues.error && issues.status !== 410) && !pulls.error;

  const releases = await readable(() => gh.listReleases(org, repo.name), 'Releases');
  if (releases.error) fail('releases', releases.error);
  const rel = releases.error ? null : releaseMetrics(releases.value, period);

  const views = await readable(() => gh.getTrafficViews(org, repo.name), 'Traffic');
  const clones = views.error ? views : await readable(() => gh.getTrafficClones(org, repo.name), 'Traffic');
  if (clones.error) fail('traffic', clones.error);

  const active = commitPart && activityComplete ? new Set([...commitPart.active, ...activity.openers]) : null;
  const newAuthors = commitPart ? [...commitPart.authors].filter(([, first]) => inPeriod(first, period)).map(([login]) => login) : null;
  const entry = {
    repo: repo.name,
    description: repo.description ?? '',
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    new_project: inPeriod(repo.created_at, period),
    active: repo.pushed_at != null && repo.pushed_at >= activeSince,
    contributors: commitPart ? countSides(commitPart.authors.keys(), people) : null,
    new_contributors: newAuthors ? countSides(newAuthors, people) : null,
    active_contributors: active ? countSides(active, people) : null,
    commits: commitPart ? commitPart.commits : null,
    prs: pulls.error ? null : activity.prs,
    issues: issues.error && issues.status !== 410 ? null : activity.issues,
    releases: rel?.releases ?? null,
    release_downloads: rel?.release_downloads ?? null,
    traffic: clones.error ? null : trafficMetrics(views.value, clones.value),
  };
  return {
    entry,
    authors: commitPart?.authors ?? null,
    active: active ?? activity.openers,
    releases: (rel?.list ?? []).map(r => ({ repo: repo.name, ...r })),
    errors,
  };
}

// ── Totals ───────────────────────────────────────────────────────────────────

const sumOf = (values, pick) => {
  const known = values.map(pick).filter(v => v != null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
};
const sumSides = (values, pick) => ({
  internal: sumOf(values, v => pick(v)?.internal) ?? 0,
  external: sumOf(values, v => pick(v)?.external) ?? 0,
});

/**
 * Totals of the organisation. People are counted once across the repositories: `collected` holds
 * the logins per repository (in memory only). A contributor is new when the earliest first week
 * over all repositories is in the period.
 */
export function computeTotals(collected, period, people) {
  const entries = collected.map(c => c.entry);
  const firstWeek = new Map();
  for (const { authors } of collected) {
    for (const [login, first] of authors ?? []) {
      if (!firstWeek.has(login) || first < firstWeek.get(login)) firstWeek.set(login, first);
    }
  }
  const active = new Set(collected.flatMap(c => [...c.active]));
  const withTraffic = entries.filter(e => e.traffic);
  return {
    public_projects: entries.length,
    new_projects: entries.filter(e => e.new_project).length,
    active_projects: entries.filter(e => e.active).length,
    stars: sumOf(entries, e => e.stars) ?? 0,
    forks: sumOf(entries, e => e.forks) ?? 0,
    contributors: countSides(firstWeek.keys(), people),
    new_contributors: countSides([...firstWeek].filter(([, first]) => inPeriod(first, period)).map(([login]) => login), people),
    active_contributors: countSides(active, people),
    commits: sumOf(entries, e => e.commits) ?? 0,
    prs_merged: sumSides(entries, e => e.prs?.merged),
    releases: sumOf(entries, e => e.releases?.period) ?? 0,
    release_downloads: sumOf(entries, e => e.release_downloads) ?? 0,
    traffic: withTraffic.length === 0 ? null : Object.fromEntries(
      ['views', 'visitors', 'clones', 'cloners'].map(k => [k, sumOf(withTraffic, e => e.traffic[k])]),
    ),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function describeSkipped(skipped) {
  const labels = [['private', 'private'], ['archived', 'archived'], ['fork', 'fork'], ['excluded_repos', 'excluded']];
  const parts = labels.map(([reason, label]) => [skipped.filter(s => s.reason === reason).length, label]).filter(([n]) => n > 0);
  return parts.length > 0 ? ` (skipped: ${parts.map(([n, label]) => `${n} ${label}`).join(', ')})` : '';
}

function logRepo(log, e) {
  const contributors = e.contributors ? `${num(e.contributors.internal + e.contributors.external)} contributors (${num(e.contributors.external)} external)` : 'contributors –';
  const merged = e.prs ? e.prs.merged.internal + e.prs.merged.external : null;
  log.debug(`  ${e.repo}: ${plural(e.stars, 'star')}, ${contributors}, ${plural(e.commits, 'commit')}, ${plural(merged, 'PR')} merged, ${plural(e.releases?.period, 'release')}, ${num(e.traffic?.visitors)} visitors`);
}

export async function run({ argv = [], env = {}, logger, github, git, sleep, polling, now = new Date() } = {}) {
  const { org, configPath, debug, json } = parseCli(argv, { defaultConfigPath: defaultConfigPath(TOOL), stringFlags: ['json'] });
  if (!json) throw new ScriptError('--json is required');
  const gh = github ?? createGitHub(createOctokit(resolveToken(env)));
  const log = logger ?? createLogger({ debug });
  const config = await loadConfig(configPath);
  const period = periodOf(now);
  const activeSince = parseRelativeDate(config.active_within, new Date(period.to)).toISOString();

  const { inScope, skipped } = scopeRepos(await gh.listOrgRepos(org), config.excluded_repos);
  const members = await gh.listOrgMembers(org);
  const people = createPeople(members, config.bots);
  log.info(`Period: ${describePeriod(period)}`);
  log.info(`Repositories: ${inScope.length} in scope${describeSkipped(skipped)}`);
  log.debug(`Organisation members: ${members.length}; active: a push since ${day(activeSince)}`);

  const options = { period, activeSince, people, sleep, polling };
  const collected = await mapWithConcurrency(inScope, CONCURRENCY, repo => collectRepo(gh, org, repo, options));
  const totals = computeTotals(collected, period, people);
  const repositories = collected.map(c => c.entry);
  const errors = collected.flatMap(c => c.errors);
  const releases = collected.flatMap(c => c.releases).sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo));

  for (const entry of repositories) logRepo(log, entry);
  const t = totals;
  const month = MONTHS[Number(period.month.slice(5, 7)) - 1];
  log.info(`Stars: ${num(t.stars)} · Forks: ${num(t.forks)} · Contributors: ${num(t.contributors.internal + t.contributors.external)} (external ${num(t.contributors.external)})`);
  log.info(`${month}: ${plural(t.new_contributors.internal + t.new_contributors.external, 'new contributor')} (external ${num(t.new_contributors.external)}), ` +
    `${num(t.active_contributors.internal + t.active_contributors.external)} active, ${plural(t.commits, 'commit')}, ` +
    `${plural(t.prs_merged.internal + t.prs_merged.external, 'PR')} merged, ${plural(t.releases, 'release')}`);
  log.info(`Unique visitors: ${num(t.traffic?.visitors)} · Unique cloners: ${num(t.traffic?.cloners)} (last 14 days)`);
  if (errors.length > 0) {
    log.info(`Not complete (in errors): ${plural(new Set(errors.map(e => e.repo)).size, 'repository', 'repositories')}`);
    for (const e of errors) log.info(`  ${e.repo} ${e.metric}: ${e.reason}`);
  }

  const header = await buildHeader({ tool: TOOL, org, configPath, issueTitle: null, env, now, git });
  const doc = {
    ...buildJsonDocument(header, { results: [], catalogue: {}, skipped, errors }),
    period,
    levels: { milestones: config.milestones, active_within: config.active_within },
    totals,
    repositories,
    releases,
  };
  await writeJsonReport(path.resolve(json), doc);
  log.info(`\nJSON written to ${json}`);
  return 0;
}

runIfMain(import.meta.url, run);
