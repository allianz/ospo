#!/usr/bin/env node

// The OpenSSF Scorecard report: turns the tool file of scorecard_check (all Scorecard checks and
// the overall score per repository) into one self-contained scorecard-data.json, carries the score
// history forward from the previous month, and renders the HTML report scorecard-report.html from it.
// Reads JSON files only and never writes to GitHub. See spec/scorecard_report_spec.md.

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

export const TOOL = 'scorecard_report';
/** Prefix of the output files (scorecard-data.json, scorecard-report.html) and of the report ID. */
export const REPORT_KEY = 'scorecard';
/** The tool file read from --dir and the script that writes it. */
export const INPUT = { file: 'scorecard.json', script: 'scripts/scorecard_check.js' };
export const TEMPLATE_PATH = fileURLToPath(new URL('./templates/scorecard_report.html', import.meta.url));
/** Header fields of the tool file copied into `input`. */
const INPUT_FIELDS = ['tool', 'run_at', 'ospo_sha', 'config_file', 'config_sha256', 'run_url', 'source', 'scorecard_version', 'scorecard_commit'];
/** Skip reasons that mean the repository is archived (not in scope). */
export const ARCHIVED_REASONS = new Set(['archived', 'archived in this run']);

const round1 = value => Math.round(value * 10) / 10;
const byName = (a, b) => a.localeCompare(b);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── Input ────────────────────────────────────────────────────────────────────

/** Problems of the `repositories` block of scorecard.json; an empty list means valid. */
export function validateRepositories(doc) {
  if (!Array.isArray(doc.repositories)) return ['repositories must be a list'];
  const problems = [];
  const seen = new Set();
  for (const entry of doc.repositories) {
    if (typeof entry?.repo !== 'string') {
      problems.push('every repositories entry needs repo');
      continue;
    }
    if (typeof entry.score !== 'number') problems.push(`repositories: score of ${entry.repo} is not a number`);
    if (seen.has(entry.repo)) problems.push(`repositories: ${entry.repo} is listed twice`);
    seen.add(entry.repo);
  }
  return problems;
}

/** Reads scorecard.json from `dir`: the `input` entry of data.json and the document (null unless ok). */
export async function readInput(dir, org) {
  const { status, hash, doc, problems } = await readToolFile(dir, INPUT, org, validateRepositories);
  const entry = { file: INPUT.file, script: INPUT.script, status, sha256: hash };
  if (status !== 'ok') return { input: problems.length > 0 ? { ...entry, problems } : entry, doc: null };
  for (const field of INPUT_FIELDS) {
    if (field in doc) entry[field] = doc[field];
  }
  entry.counts = { results: doc.results.length, skipped: doc.skipped.length, errors: doc.errors.length, repositories: doc.repositories.length };
  return { input: entry, doc };
}

// ── Compute ──────────────────────────────────────────────────────────────────

/** Active and archived repositories, from the results, repositories, skipped and errors of the tool file. */
export function computeScope(doc) {
  const archived = new Set(doc.skipped.filter(row => ARCHIVED_REASONS.has(row.reason)).map(row => row.repo));
  const seen = new Set([...doc.results, ...doc.repositories, ...doc.skipped, ...doc.errors].map(row => row.repo).filter(Boolean));
  return {
    active: [...seen].filter(repo => !archived.has(repo)).sort(byName),
    archived: [...archived].sort(byName),
  };
}

/** Mean of the values with one decimal, null for none. */
export function average(values) {
  return values.length > 0 ? round1(values.reduce((sum, v) => sum + v, 0) / values.length) : null;
}

/** Median of the values with one decimal, null for none. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** Summary of the run: scanned repositories, overall scores, check results. */
export function computeSummary({ scope, repositories, results, errors }) {
  const scores = repositories.map(r => r.score);
  const count = result => results.filter(row => row.result === result).length;
  return {
    repositories_active: scope.active.length,
    repositories_scanned: repositories.length,
    average_score: average(scores),
    median_score: median(scores),
    checks_passed: count('pass'),
    checks_failed: count('fail'),
    checks_na: count('na'),
    repositories_with_findings: new Set(results.filter(row => row.result === 'fail').map(row => row.repo)).size,
    repositories_with_errors: new Set(errors.map(row => row.repo).filter(Boolean)).size,
  };
}

/** The history entry of this run: average and overall score per scanned repository. */
export function historyEntry(month, summary, repositories) {
  return { month, average_score: summary.average_score, scores: Object.fromEntries(repositories.map(r => [r.repo, r.score])) };
}

/** Builds scorecard-data.json from the tool file and the previous report (pure). A missing or invalid input gives an empty report. */
export function buildData({ input, doc, previous, header, env = {} }) {
  const empty = { catalogue: {}, results: [], skipped: [], errors: [], repositories: [] };
  const source = doc ?? empty;
  const scope = doc ? computeScope(doc) : { active: [], archived: [] };
  const active = new Set(scope.active);
  const repositories = source.repositories
    .filter(r => active.has(r.repo))
    .map(({ repo, commit, date, score }) => ({ repo, commit: commit ?? null, date: date ?? null, score }))
    .sort((a, b) => byName(a.repo, b.repo));
  const results = source.results
    .filter(row => active.has(row.repo))
    .map(({ repo, check, result, score, reason, details }) => ({ repo, check, result, score: score ?? null, reason: reason ?? '', details: details ?? [] }));
  const errors = source.errors.map(({ repo, check, reason }) => ({ repo: repo ?? null, check: check ?? null, reason }));
  const summary = computeSummary({ scope, repositories, results, errors });
  const month = header.run_at.slice(0, 7);
  return {
    report_id: `OSPO-SC-${month}`,
    ...header,
    previous_report: previous
      ? { report_id: previous.doc.report_id ?? null, data_url: blobUrl(previous.path, { env }) }
      : null,
    input,
    scope,
    summary,
    history: mergeHistory(previous?.doc.history, historyEntry(month, summary, repositories)),
    repositories,
    catalogue: source.catalogue,
    results,
    skipped: source.skipped.map(({ repo, reason }) => ({ repo, reason })),
    errors,
  };
}

/** The page title, e.g. "OpenSSF Scorecard Report · allianz · 2026-11". */
export function reportTitle(data) {
  return `OpenSSF Scorecard Report · ${data.org} · ${data.run_at.slice(0, 7)}`;
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
  const { input, scope, summary: s } = data;
  log.info(`Report: OpenSSF Scorecard (${data.report_id})`);
  const detail = input.status === 'ok'
    ? `ok (${input.counts.results} results, ${input.counts.skipped} skipped, ${input.counts.errors} errors), Scorecard ${input.scorecard_version ?? 'unknown'}`
    : [input.status, ...(input.problems ?? [])].join(': ');
  log.info(`Input: ${input.file} ${detail}`);
  log.info(`Scope: ${scope.active.length} active, ${scope.archived.length} archived repositories; ${s.repositories_scanned} scanned`);
  const before = data.history.length > 1 ? data.history.at(-2).average_score : null;
  log.info(`Average score: ${s.average_score ?? '–'}${before !== null ? ` (previous ${before})` : ''}, median ${s.median_score ?? '–'}`);
  for (const repo of data.repositories) {
    const failed = data.results.filter(row => row.repo === repo.repo && row.result === 'fail').length;
    log.debug(`  ${repo.repo} ${repo.score} (${failed} failed)`);
  }
  log.info(`Checks: ${s.checks_passed} passed, ${s.checks_failed} failed, ${s.checks_na} not applicable; ${s.repositories_with_findings} repositories with findings`);
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
