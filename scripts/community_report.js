#!/usr/bin/env node

// The community report: turns the tool file of community_metrics (the metrics of the previous month
// per repository and for the organisation) into one self-contained community-data.json with growth,
// milestones and highlights, carries the history forward from the previous month, and renders the
// HTML report community-report.html from it. Reads JSON files only and never writes to GitHub.
// See spec/community_report_spec.md.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';

import { ScriptError, parseCli, runIfMain } from './lib/cli.js';
import { blobUrl, isoSeconds, resolveOspoSha, runUrl, writeJsonReport } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';
import { loadTemplate, renderHtml } from './lib/report_html.js';
import { DEFAULT_REPORTS_PATH, mergeHistory, readPreviousReport, readToolFile } from './lib/report_files.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const TOOL = 'community_report';
/** Prefix of the output files (community-data.json, community-report.html). */
export const REPORT_KEY = 'community';
/** The tool file read from --dir and the script that writes it. */
export const INPUT = { file: 'community.json', script: 'scripts/community_metrics.js' };
export const TEMPLATE_PATH = fileURLToPath(new URL('./templates/community_report.html', import.meta.url));
/** Header fields of the tool file copied into `input`. */
const INPUT_FIELDS = ['tool', 'run_at', 'ospo_sha', 'config_file', 'config_sha256', 'run_url'];
/** Months back for the second change of every headline number ("vs Apr"); the report shows as many months of trends. */
export const TREND_MONTHS = 6;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const num = n => (n == null ? '–' : n.toLocaleString('en'));
const plural = (n, singular, pluralForm = `${singular}s`) => `${num(n)} ${n === 1 ? singular : pluralForm}`;
const sides = x => (x ? x.internal + x.external : null);
const byName = (a, b) => a.localeCompare(b);

/** "2026-10" plus `k` months. */
export function addMonths(month, k) {
  const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + k;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

const monthName = month => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** The period of a run in `month` (the calendar month before), as community_metrics computes it. */
export function periodBefore(month) {
  const period = addMonths(month, -1);
  return { month: period, from: `${period}-01T00:00:00Z`, to: `${month}-01T00:00:00Z` };
}

/** Every headline number of the report, read from the totals of a history entry. */
export const METRICS = {
  stars: t => t.stars,
  visitors: t => t.traffic?.visitors,
  cloners: t => t.traffic?.cloners,
  views: t => t.traffic?.views,
  clones: t => t.traffic?.clones,
  contributors: t => sides(t.contributors),
  external_contributors: t => t.contributors?.external,
  public_projects: t => t.public_projects,
  prs_merged: t => sides(t.prs_merged),
  releases: t => t.releases,
};

/** How a milestone reads in a highlight: "The organisation passed 5,000 stars." */
export const MILESTONE_LABELS = {
  visitors: 'unique visitors in 14 days',
  stars: 'stars',
  public_projects: 'public projects',
  contributors: 'contributors',
  external_contributors: 'external contributors',
};

const EMPTY_TOTALS = {
  public_projects: null, new_projects: null, active_projects: null, stars: null, forks: null,
  contributors: null, new_contributors: null, active_contributors: null, commits: null,
  prs_merged: null, releases: null, release_downloads: null, traffic: null,
};

// ── Input ────────────────────────────────────────────────────────────────────

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Problems of the community blocks of community.json; an empty list means valid. */
export function validateCommunity(doc) {
  const problems = [];
  const p = doc.period;
  if (!isObject(p) || !/^\d{4}-\d{2}$/.test(p.month ?? '') || typeof p.from !== 'string' || typeof p.to !== 'string') {
    problems.push('period must have month (YYYY-MM), from and to');
  }
  if (!isObject(doc.levels) || !isObject(doc.levels.milestones)) problems.push('levels.milestones must be an object');
  if (!isObject(doc.totals)) problems.push('totals must be an object');
  if (!Array.isArray(doc.releases)) problems.push('releases must be a list');
  if (!Array.isArray(doc.repositories)) return [...problems, 'repositories must be a list'];
  const seen = new Set();
  for (const entry of doc.repositories) {
    if (typeof entry?.repo !== 'string') {
      problems.push('every repositories entry needs repo');
      continue;
    }
    if (seen.has(entry.repo)) problems.push(`repositories: ${entry.repo} is listed twice`);
    seen.add(entry.repo);
  }
  return problems;
}

/** Reads community.json from `dir`: the `input` entry of data.json and the document (null unless ok). */
export async function readInput(dir, org) {
  const { status, hash, doc, problems } = await readToolFile(dir, INPUT, org, validateCommunity);
  const entry = { file: INPUT.file, script: INPUT.script, status, sha256: hash };
  if (status !== 'ok') return { input: problems.length > 0 ? { ...entry, problems } : entry, doc: null };
  for (const field of INPUT_FIELDS) {
    if (field in doc) entry[field] = doc[field];
  }
  entry.counts = { repositories: doc.repositories.length, skipped: doc.skipped.length, errors: doc.errors.length };
  return { input: entry, doc };
}

// ── Compute ──────────────────────────────────────────────────────────────────

/** The history entry of this run: the totals, the per-project numbers of the trends and the milestones held. */
export function historyEntry(month, period, totals, repositories, milestones) {
  const traffic = t => (t ? { views: t.views, visitors: t.visitors, clones: t.clones, cloners: t.cloners } : null);
  return {
    month,
    period: period.month,
    totals: { ...totals, traffic: traffic(totals.traffic) },
    repositories: Object.fromEntries(repositories.map(r => [r.repo, {
      traffic: traffic(r.traffic),
      stars: r.stars,
      forks: r.forks,
      contributors: r.contributors ?? null,
      prs_merged: r.prs?.merged ?? null,
      commits: r.commits ?? null,
      releases_total: r.releases?.total ?? null,
      release_downloads: r.release_downloads ?? null,
    }])),
    milestones,
  };
}

/** Per headline number: this month's value, the one of the month before and the one 6 months before (null without that entry). */
export function computeGrowth(history, periodMonth) {
  const byPeriod = new Map(history.map(e => [e.period, e]));
  const at = (k, read) => {
    const totals = byPeriod.get(addMonths(periodMonth, k))?.totals;
    return totals ? (read(totals) ?? null) : null;
  };
  return Object.fromEntries(Object.entries(METRICS).map(([key, read]) => [key, {
    value: at(0, read),
    previous: at(-1, read),
    six_months_ago: at(-TREND_MONTHS, read),
  }]));
}

/** The milestones the totals reach: `<metric>-<level>` for every level of `levels.milestones`. */
export function heldMilestones(milestoneLevels, totals) {
  const held = [];
  for (const [metric, levels] of Object.entries(milestoneLevels)) {
    const value = METRICS[metric]?.(totals);
    for (const level of levels) if (value != null && value >= level) held.push(`${metric}-${level}`);
  }
  return held;
}

/** The latest history entry of a period before `periodMonth` (the one milestones and first contributors compare with), or null. */
export function previousEntry(history, periodMonth) {
  return [...history].filter(e => e.period < periodMonth).sort((a, b) => a.period.localeCompare(b.period)).at(-1) ?? null;
}

/** The highlight sentences of the month, in the order of the report. */
export function buildHighlights({ newMilestones, repositories, totals, before, periodMonth }) {
  const highlights = [];
  const highest = new Map();
  for (const id of newMilestones) {
    const [metric, level] = [id.slice(0, id.lastIndexOf('-')), Number(id.slice(id.lastIndexOf('-') + 1))];
    if (!highest.has(metric) || level > highest.get(metric)) highest.set(metric, level);
  }
  for (const [metric, level] of highest) {
    highlights.push({ kind: 'milestone', icon: '🎉', text: `The organisation passed ${num(level)} ${MILESTONE_LABELS[metric]}.` });
  }
  for (const r of repositories.filter(x => x.new_project)) {
    const description = (r.description ?? '').trim();
    highlights.push({ kind: 'new', icon: '🆕', repo: r.repo, text: description ? `was published: ${description.replace(/\.?$/, '.')}` : 'was published.' });
  }
  for (const r of repositories) {
    const earlier = before?.repositories?.[r.repo]?.contributors;
    if (earlier?.external === 0 && r.contributors?.external > 0) {
      highlights.push({ kind: 'first_external', icon: '🌍', repo: r.repo, text: 'got its first external contributor.' });
    }
  }
  const nc = totals.new_contributors;
  const newcomers = sides(nc);
  if (newcomers > 0) {
    let text;
    if (newcomers === 1) text = nc.external ? '1 person from outside Allianz made their first contribution.' : '1 person made their first contribution.';
    else text = `${num(newcomers)} people made their first contribution${nc.external ? `, ${num(nc.external)} of them from outside Allianz` : ''}.`;
    highlights.push({ kind: 'welcome', icon: '👋', text });
  }
  if (totals.releases > 0) {
    highlights.push({ kind: 'releases', icon: '🚀', text: `${plural(totals.releases, 'release')} in ${MONTHS[Number(periodMonth.slice(5, 7)) - 1]}.` });
  }
  return highlights;
}

/** Builds community-data.json from the tool file and the previous report (pure). A missing or invalid input gives an empty report. */
export function buildData({ input, doc, previous, header, env = {} }) {
  const month = header.run_at.slice(0, 7);
  const period = doc?.period ?? periodBefore(month);
  const levels = doc?.levels ?? { milestones: {} };
  const totals = doc?.totals ?? EMPTY_TOTALS;
  const repositories = [...(doc?.repositories ?? [])].sort((a, b) => byName(a.repo, b.repo));
  const previousHistory = previous?.doc.history ?? [];
  const before = previousEntry(previousHistory, period.month);
  const milestones = doc ? heldMilestones(levels.milestones, totals) : [];
  const newMilestones = before ? milestones.filter(id => !(before.milestones ?? []).includes(id)) : [];
  // Without data this month adds no history entry: the next report compares with the last month that has data
  const history = doc ? mergeHistory(previousHistory, historyEntry(month, period, totals, repositories, milestones)) : previousHistory;
  return {
    report_id: `OSPO-CM-${month}`,
    ...header,
    previous_report: previous
      ? { report_id: previous.doc.report_id ?? null, data_url: blobUrl(previous.path, { env }) }
      : null,
    input,
    period,
    levels,
    totals,
    growth: computeGrowth(history, period.month),
    repositories,
    milestones,
    new_milestones: newMilestones,
    highlights: doc ? buildHighlights({ newMilestones, repositories, totals, before, periodMonth: period.month }) : [],
    releases: doc?.releases ?? [],
    history,
    skipped: (doc?.skipped ?? []).map(({ repo, reason }) => ({ repo, reason })),
    errors: (doc?.errors ?? []).map(({ repo, metric, reason }) => ({ repo: repo ?? null, metric: metric ?? null, reason })),
  };
}

/** The page title, e.g. "Open Source Community Report · allianz · 2026-11". */
export function reportTitle(data) {
  return `Open Source Community Report · ${data.org} · ${data.run_at.slice(0, 7)}`;
}

// ── Output ───────────────────────────────────────────────────────────────────

/** The data-health warnings: input missing or invalid, errors. */
export function dataHealth(data) {
  const warnings = [];
  if (data.input.status !== 'ok') warnings.push(`data health: ${data.input.file} ${data.input.status}`);
  if (data.errors.length > 0) warnings.push(`data health: ${plural(data.errors.length, 'error')} (no data)`);
  return warnings;
}

function logReport(log, data) {
  const { input, growth: g } = data;
  log.info(`Report: Open Source Community (${data.report_id})`);
  const detail = input.status === 'ok'
    ? `ok (${plural(input.counts.repositories, 'repository', 'repositories')}, ${input.counts.skipped} skipped, ${plural(input.counts.errors, 'error')})`
    : [input.status, ...(input.problems ?? [])].join(': ');
  log.info(`Input: ${input.file} ${detail}`);
  log.info(`Period: ${monthName(data.period.month)}`);
  const withPrevious = (label, x) => `${label}: ${num(x.value)}${x.previous != null ? ` (previous ${num(x.previous)})` : ''}`;
  log.info([withPrevious('Stars', g.stars), withPrevious('Unique visitors', g.visitors), withPrevious('Contributors', g.contributors)].join(' · '));
  log.info(`Milestones: ${data.milestones.length} held, ${data.new_milestones.length} new${data.new_milestones.length > 0 ? `: ${data.new_milestones.join(', ')}` : ''}`);
  log.info(`Highlights: ${data.highlights.length}`);
  for (const h of data.highlights) log.debug(`  ${h.icon} ${h.repo ? `${h.repo} ` : ''}${h.text}`);
  log.info(`History: ${plural(data.history.length, 'month')} (previous report: ${data.previous_report?.report_id ?? 'none'})`);
  for (const warning of dataHealth(data)) log.info(`Warning: ${warning}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger, git = simpleGit, now = new Date() } = {}) {
  const { org, debug, dir, reports } = parseCli(argv, { stringFlags: ['dir', 'reports'] });
  if (!dir) throw new ScriptError('--dir is required');
  const log = logger ?? createLogger({ debug });

  const { input, doc } = await readInput(path.resolve(dir), org);
  const header = { run_at: isoSeconds(now), org, ospo_sha: await resolveOspoSha(env, git), run_url: runUrl(env) };
  const reportsDir = path.resolve(reports ?? DEFAULT_REPORTS_PATH);
  const previous = await readPreviousReport(reportsDir, REPORT_KEY, header.run_at.slice(0, 7));
  const data = buildData({ input, doc, previous, header, env });

  logReport(log, data);
  const monthDir = path.join(reportsDir, data.run_at.slice(0, 7));
  const dataFile = path.join(monthDir, `${REPORT_KEY}-data.json`);
  const htmlFile = path.join(monthDir, `${REPORT_KEY}-report.html`);
  await writeJsonReport(path.resolve(dataFile), data);
  await writeFile(path.resolve(htmlFile), renderHtml(data, await loadTemplate(TEMPLATE_PATH), reportTitle(data)));
  log.info(`\nJSON written to ${dataFile}`);
  log.info(`HTML written to ${htmlFile}`);
  return 0;
}

runIfMain(import.meta.url, run);
