// Files of the compliance report: reading and validating the tool files of a run, and the reports
// folder with one subfolder per month that carries the history from one report to the next.
// See spec/compliance_report_spec.md.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { ScriptError } from './cli.js';
import { repoRoot } from './config.js';
import { sha256 } from './json_output.js';

/** Reports folder of the repository, one folder per month (reports/2026-11/allianz-data.json). */
export const REPORTS_DIR = 'reports';
/** Default output directory: the reports folder of the repository, committed by pull request. */
export const DEFAULT_REPORTS_PATH = path.join(repoRoot, REPORTS_DIR);
/** Header fields every tool file has (draft 1.6). */
export const HEADER_FIELDS = ['tool', 'run_at', 'org', 'ospo_sha', 'config_file', 'config_sha256', 'run_url', 'issue_title'];
const RESULTS = ['pass', 'fail', 'na'];

const key = (repo, check) => `${repo}\u0000${check}`;

// ── Tool files ───────────────────────────────────────────────────────────────

/** Problems of a tool file against the common format (draft 1.6); an empty list means valid. */
export function validateToolFile(doc, input, org) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not a JSON object'];
  const problems = [];
  const missing = HEADER_FIELDS.filter(f => !(f in doc));
  if (missing.length > 0) problems.push(`missing header fields: ${missing.join(', ')}`);
  const expectedTool = path.basename(input.script, '.js');
  if ('tool' in doc && doc.tool !== expectedTool) problems.push(`tool is '${doc.tool}', expected '${expectedTool}'`);
  if ('org' in doc && doc.org !== org) problems.push(`org is '${doc.org}', expected '${org}'`);
  if (!doc.catalogue || typeof doc.catalogue !== 'object' || Array.isArray(doc.catalogue)) problems.push('catalogue must be an object');
  for (const field of ['results', 'skipped', 'errors']) {
    if (!Array.isArray(doc[field])) problems.push(`${field} must be a list`);
  }
  if (problems.length > 0) return problems;

  const seen = new Set();
  for (const row of doc.results) {
    if (!(row?.check in doc.catalogue)) problems.push(`check ${row?.check} of ${row?.repo} is not in the catalogue`);
    if (!RESULTS.includes(row?.result)) problems.push(`invalid result '${row?.result}' for ${row?.repo} ${row?.check}`);
    if (seen.has(key(row?.repo, row?.check))) problems.push(`duplicate result for ${row?.repo} ${row?.check}`);
    seen.add(key(row?.repo, row?.check));
  }
  return problems;
}

/**
 * Reads one tool file `input.file` from `dir`: `{ status, hash, doc, problems }` with status `ok`,
 * `missing` (no file; hash null) or `invalid` (not JSON or against the common format; doc null).
 * `validate(doc)` can add problems of its own. Read errors other than a missing file are thrown.
 */
export async function readToolFile(dir, input, org, validate = () => []) {
  let raw;
  try {
    raw = await readFile(path.join(dir, input.file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { status: 'missing', hash: null, doc: null, problems: [] };
  }
  const hash = sha256(raw);
  let doc;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    return { status: 'invalid', hash, doc: null, problems: [`not valid JSON: ${error.message}`] };
  }
  const problems = validateToolFile(doc, input, org);
  if (problems.length === 0) problems.push(...validate(doc));
  if (problems.length > 0) return { status: 'invalid', hash, doc: null, problems };
  return { status: 'ok', hash, doc, problems: [] };
}

// ── Reports folder and history ───────────────────────────────────────────────

/** Path of a report's data.json in the repository: reports/2026-11/allianz-data.json. */
export const dataPath = (month, reportKey) => `${REPORTS_DIR}/${month}/${reportKey}-data.json`;

/**
 * The previous data.json of this report: the one in the latest month folder of the reports directory
 * before `month`. In CI the directory is the checkout of main, so it holds the merged reports only.
 * Returns `{ month, path, doc }` (`path` relative to the repository), or null when there is none
 * (first report). A file that is not valid JSON stops the run.
 */
export async function readPreviousReport(reportsDir, reportKey, month) {
  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const months = entries
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name) && e.name < month)
    .map(e => e.name)
    .sort()
    .reverse();
  for (const previousMonth of months) {
    const file = path.join(reportsDir, previousMonth, `${reportKey}-data.json`);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try {
      return { month: previousMonth, path: dataPath(previousMonth, reportKey), doc: JSON.parse(text) };
    } catch (error) {
      throw new ScriptError(`${file} is not valid JSON: ${error.message}`);
    }
  }
  return null;
}

/** The previous history with this run's entry added; an entry of the same month is replaced. Sorted by month. */
export function mergeHistory(previous, entry) {
  return [...(previous ?? []).filter(e => e.month !== entry.month), entry].sort((a, b) => a.month.localeCompare(b.month));
}
