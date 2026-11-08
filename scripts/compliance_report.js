#!/usr/bin/env node

// Aggregates the tool files of one compliance run into one self-contained <key>-data.json per
// report configuration: merges results, maps checks to requirements, computes statuses, carries
// the trend history forward. Reads JSON files only and never writes to GitHub.
// Writes <reports>/<YYYY-MM>/<key>-data.json and the HTML report <key>-report.html rendered from it.
// See spec/compliance_report_spec.md.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { ScriptError, parseCli, runIfMain } from './lib/cli.js';
import { loadYaml, repoRoot, requireFields } from './lib/config.js';
import { blobUrl, isoSeconds, repoRelative, resolveOspoSha, runUrl, sha256, writeJsonReport } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';
import { loadTemplate, renderHtml } from './lib/report_html.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const TOOL = 'compliance_report';
/** Reports folder of the repository, one folder per month (reports/2026-11/bsi-data.json). */
export const REPORTS_DIR = 'reports';
/** Default output directory: the reports folder of the repository, committed by pull request. */
export const DEFAULT_REPORTS_PATH = path.join(repoRoot, REPORTS_DIR);

const LEVELS = ['MUST', 'SHOULD', 'MAY'];
const RESULTS = ['pass', 'fail', 'na'];
export const STATUSES = ['met', 'met-findings', 'not-met', 'no-data', 'not-assessed', 'optional'];
/** Statuses whose checks count in the summary and the history. */
const ASSESSED = new Set(['met', 'met-findings', 'no-data']);
const HEADER_FIELDS = ['tool', 'run_at', 'org', 'ospo_sha', 'config_file', 'config_sha256', 'run_url', 'issue_title'];
/** Optional header fields copied into inputs when present (scorecard_check). */
const EXTRA_HEADER_FIELDS = ['source', 'scorecard_version'];
/** Skip reasons that mean the repository is archived (out of scope). */
export const ARCHIVED_REASONS = new Set(['archived', 'archived in this run']);
export const EXCLUDED_REASON = 'excluded_repos';
export const NOTES_HEADINGS = { 'Key messages': 'key_messages', 'Needs attention': 'needs_attention' };

const key = (repo, check) => `${repo}\u0000${check}`;
const round1 = value => Math.round(value * 10) / 10;
const percent = (part, total) => (total > 0 ? round1((part / total) * 100) : null);

// ── Config ───────────────────────────────────────────────────────────────────

/** Loads and validates a report configuration. Requirements become a list in file order. */
export async function loadReportConfig(configPath) {
  const config = await loadYaml(configPath);
  requireFields(config, ['key', 'framework', 'inputs', 'requirements'], configPath);
  const fail = message => { throw new ScriptError(`${message} (in ${configPath})`); };
  if (!/^[a-z0-9-]+$/.test(config.key)) fail(`key must consist of a-z, 0-9 and -: '${config.key}'`);
  const chapters = config.framework.chapters ?? {};
  for (const input of config.inputs) {
    if (typeof input?.file !== 'string' || typeof input?.script !== 'string') fail('every input needs file and script');
  }
  const requirements = Object.entries(config.requirements).map(([id, r]) => {
    const chapter = id.split('.')[0];
    if (!(chapter in chapters)) fail(`requirement ${id}: chapter ${chapter} is not in framework.chapters`);
    if (!LEVELS.includes(r?.level)) fail(`requirement ${id}: level must be one of ${LEVELS.join(', ')}`);
    if (!r.title) fail(`requirement ${id}: title is missing`);
    if (!Array.isArray(r.checks)) fail(`requirement ${id}: checks must be a list (use [] for none)`);
    return {
      id,
      chapter,
      level: r.level,
      title: r.title,
      text: r.text ?? [],
      implementation: r.implementation ?? '',
      checks: r.checks,
    };
  });
  return { ...config, requirements };
}

/** All check IDs mapped to at least one requirement. */
export function mappedChecks(requirements) {
  return new Set(requirements.flatMap(r => r.checks));
}

// ── Step 1–2: read and validate the tool files ──────────────────────────────

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

/** The `inputs` entry of a valid file: status, hash, the header fields the report shows, counts. */
function inputEntry(input, status, { hash = null, doc = null, problems = [] } = {}) {
  const entry = { file: input.file, script: input.script, status, sha256: hash };
  if (status !== 'ok') return problems.length > 0 ? { ...entry, problems } : entry;
  for (const field of [...HEADER_FIELDS.filter(f => f !== 'org'), ...EXTRA_HEADER_FIELDS]) {
    if (field in doc) entry[field] = doc[field];
  }
  entry.counts = { results: doc.results.length, skipped: doc.skipped.length, errors: doc.errors.length };
  return entry;
}

/** Reads every input file of the report configuration. Returns the `inputs` entries and the valid documents. */
export async function readInputs(dir, inputs, org) {
  const entries = [];
  const docs = [];
  for (const input of inputs) {
    let raw;
    try {
      raw = await readFile(path.join(dir, input.file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries.push(inputEntry(input, 'missing'));
      continue;
    }
    const hash = sha256(raw);
    let doc;
    try {
      doc = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      entries.push(inputEntry(input, 'invalid', { hash, problems: [`not valid JSON: ${error.message}`] }));
      continue;
    }
    const problems = validateToolFile(doc, input, org);
    if (problems.length > 0) {
      entries.push(inputEntry(input, 'invalid', { hash, problems }));
      continue;
    }
    entries.push(inputEntry(input, 'ok', { hash, doc }));
    docs.push(doc);
  }
  return { inputs: entries, docs };
}

// ── Step 3–4: merge ──────────────────────────────────────────────────────────

/** Active and archived repositories, from the results, skipped and errors of all tool files. */
export function computeScope(docs) {
  const archived = new Set();
  const seen = new Set();
  for (const doc of docs) {
    for (const row of [...doc.results, ...doc.skipped, ...doc.errors]) {
      if (row.repo) seen.add(row.repo);
    }
    for (const row of doc.skipped) {
      if (ARCHIVED_REASONS.has(row.reason)) archived.add(row.repo);
    }
  }
  const sorted = set => [...set].sort((a, b) => a.localeCompare(b));
  return { active: sorted([...seen].filter(r => !archived.has(r))), archived: sorted(archived) };
}

/**
 * Merges the valid tool files, reduced to the mapped checks and the active repositories.
 * A check ID defined by two tools stops the run.
 */
export function mergeToolFiles(docs, mapped, scope) {
  const catalogue = {};
  for (const doc of docs) {
    for (const [check, entry] of Object.entries(doc.catalogue)) {
      if (!mapped.has(check)) continue;
      if (catalogue[check]) throw new ScriptError(`Check ${check} is defined by ${catalogue[check].tool} and ${doc.tool}`);
      const { url, short } = entry.documentation ?? {};
      catalogue[check] = {
        tool: doc.tool,
        ...(entry.threshold !== undefined ? { threshold: entry.threshold } : {}),
        documentation: { url, short },
      };
    }
  }
  const active = new Set(scope.active);
  const results = docs.flatMap(doc =>
    doc.results
      .filter(row => mapped.has(row.check) && active.has(row.repo))
      .map(({ repo, check, result, score }) => ({ repo, check, result, ...('threshold' in catalogue[check] ? { score: score ?? null } : {}) })),
  );
  const skipped = docs.flatMap(doc => doc.skipped.map(({ repo, reason }) => ({ tool: doc.tool, repo, reason })));
  const errors = docs.flatMap(doc =>
    doc.errors
      .filter(row => !row.check || mapped.has(row.check))
      .map(({ repo, check, reason }) => ({ tool: doc.tool, repo: repo ?? null, check: check ?? null, reason })),
  );
  return { catalogue: sortKeys(catalogue), results, skipped, errors };
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

/** A `fail` for every mapped check of a tool that skipped an active repository through excluded_repos (draft 1.2). */
export function excludedFailResults(docs, mapped, scope) {
  const active = new Set(scope.active);
  const rows = [];
  for (const doc of docs) {
    const checks = Object.keys(doc.catalogue).filter(check => mapped.has(check));
    for (const { repo, reason } of doc.skipped) {
      if (reason !== EXCLUDED_REASON || !active.has(repo)) continue;
      for (const check of checks) {
        rows.push({ repo, check, result: 'fail', ...(doc.catalogue[check].threshold !== undefined ? { score: null } : {}) });
      }
    }
  }
  return rows;
}

// ── Step 5: compute ──────────────────────────────────────────────────────────

/** Index of results by repository and check. */
export function indexResults(results) {
  return new Map(results.map(row => [key(row.repo, row.check), row.result]));
}

/**
 * How one repository does on a set of checks: `failing` (any fail), `no_data` (no fail, but a check
 * without a result), `not_applicable` (all na) or `passing`.
 */
export function repositoryOutcome(repo, checks, index) {
  const values = checks.map(check => index.get(key(repo, check)));
  if (values.includes('fail')) return 'failing';
  if (values.includes(undefined)) return 'no_data';
  if (values.every(v => v === 'na')) return 'not_applicable';
  return 'passing';
}

/** Status and repository counts of every requirement (draft 1.7). */
export function assessRequirements(requirements, results, scope) {
  const index = indexResults(results);
  return requirements.map(requirement => {
    const { checks, level } = requirement;
    if (checks.length === 0) {
      return { ...requirement, status: level === 'MUST' ? 'not-met' : 'not-assessed', repositories: null, coverage: null };
    }
    const repositories = { applicable: 0, passing: 0, failing: 0, not_applicable: 0, no_data: 0 };
    for (const repo of scope.active) repositories[repositoryOutcome(repo, checks, index)] += 1;
    repositories.applicable = repositories.passing + repositories.failing;
    let status;
    if (level === 'MAY') status = 'optional';
    else if (repositories.failing > 0) status = 'met-findings';
    else if (repositories.passing + repositories.not_applicable === 0) status = 'no-data';
    else status = 'met';
    return { ...requirement, status, repositories, coverage: percent(repositories.passing, repositories.applicable) };
  });
}

/** Summary over the assessed requirements: checks, compliance %, statuses, repositories with findings. */
export function computeSummary(assessed, results, scope) {
  const counted = mappedChecks(assessed.filter(r => ASSESSED.has(r.status)));
  const rows = results.filter(row => counted.has(row.check));
  const evaluated = rows.filter(row => row.result !== 'na').length;
  const passed = rows.filter(row => row.result === 'pass').length;

  const index = indexResults(results);
  const failing = scope.active.filter(repo =>
    assessed.some(r => ASSESSED.has(r.status) && repositoryOutcome(repo, r.checks, index) === 'failing'),
  );
  const musts = assessed.filter(r => r.level === 'MUST');
  return {
    checks_evaluated: evaluated,
    checks_passed: passed,
    compliance_pct: percent(passed, evaluated),
    requirements_by_status: Object.fromEntries(STATUSES.map(s => [s, assessed.filter(r => r.status === s).length])),
    must_met: musts.filter(r => r.status === 'met' || r.status === 'met-findings').length,
    must_total: musts.length,
    failing_repositories: failing.length,
  };
}

// ── Step 6: history ──────────────────────────────────────────────────────────

/** The history entry of this run. */
export function historyEntry(month, summary, assessed) {
  return {
    month,
    compliance_pct: summary.compliance_pct,
    failing_repositories: summary.failing_repositories,
    coverage: Object.fromEntries(assessed.filter(r => ASSESSED.has(r.status)).map(r => [r.id, r.coverage])),
  };
}

/** The previous history with this run's entry added; an entry of the same month is replaced. Sorted by month. */
export function mergeHistory(previous, entry) {
  return [...(previous ?? []).filter(e => e.month !== entry.month), entry].sort((a, b) => a.month.localeCompare(b.month));
}

/** Path of a report's data.json in the repository: reports/2026-11/bsi-data.json. */
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

// ── Step 7: notes ────────────────────────────────────────────────────────────

export class NotesError extends Error {}

/** Throws a NotesError unless the text uses only **bold**, `code` and [text](https://…) (no images). */
export function checkInlineMarkdown(text) {
  const rest = text
    .replace(/`[^`]+`/g, 'x')
    .replace(/!\[/g, '<')
    .replace(/\[([^\]]+)\]\(https:\/\/[^\s)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
  if (/[*`[\]<>]|(^|\W)_|_(\W|$)/.test(rest)) throw new NotesError(`unsupported Markdown in: ${text}`);
}

/**
 * Parses a notes file: exactly the headings "## Key messages" and "## Needs attention", in this
 * order, each followed by "- " bullets (one per line) and blank lines. Anything else throws a NotesError.
 */
export function parseNotes(text) {
  const notes = {};
  const headings = Object.keys(NOTES_HEADINGS);
  let current = null;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      const expected = headings[Object.keys(notes).length];
      if (heading[1] !== expected) throw new NotesError(`line ${i + 1}: expected heading "## ${expected ?? '(none)'}"`);
      current = NOTES_HEADINGS[expected];
      notes[current] = [];
      continue;
    }
    const bullet = line.match(/^- (\S.*?)\s*$/);
    if (!bullet || !current) throw new NotesError(`line ${i + 1}: expected a "- " bullet under a heading`);
    try {
      checkInlineMarkdown(bullet[1]);
    } catch (error) {
      throw new NotesError(`line ${i + 1}: ${error.message}`);
    }
    notes[current].push(bullet[1]);
  }
  if (Object.keys(notes).length !== headings.length) throw new NotesError(`missing heading "## ${headings[Object.keys(notes).length]}"`);
  return notes;
}

/** Reads the notes file: `{ notes, error }`. A missing file gives notes null and no error. */
export async function readNotes(notesPath) {
  const file = path.resolve(repoRoot, notesPath);
  let raw;
  try {
    raw = await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { notes: null, error: null };
    throw error;
  }
  try {
    return { notes: { file: notesPath, sha256: sha256(raw), ...parseNotes(raw.toString('utf8')) }, error: null };
  } catch (error) {
    if (!(error instanceof NotesError)) throw error;
    return { notes: null, error: `Notes file ${notesPath} is invalid: ${error.message}` };
  }
}

// ── data.json ────────────────────────────────────────────────────────────────

/** Mapped checks that no tool file defines although all inputs were read: most likely a typo in the mapping. */
export function unknownChecks(mapped, catalogue, inputs) {
  if (inputs.some(i => i.status !== 'ok')) return [];
  return [...mapped].filter(check => !(check in catalogue)).sort();
}

/** Builds data.json from the tool documents, the report configuration and the previous report (pure). */
export function buildData({ config, configFile, configSha, inputs, docs, previous, notes, notesError, header, env = {} }) {
  const mapped = mappedChecks(config.requirements);
  const scope = computeScope(docs);
  const merged = mergeToolFiles(docs, mapped, scope);
  const results = [...merged.results, ...excludedFailResults(docs, mapped, scope)];
  const requirements = assessRequirements(config.requirements, results, scope);
  const summary = computeSummary(requirements, results, scope);
  const month = header.run_at.slice(0, 7);
  const errors = [...merged.errors];
  if (notesError) errors.push({ tool: TOOL, repo: null, check: null, reason: notesError });

  return {
    report_id: `OSPO-CR-${config.key.toUpperCase()}-${month}`,
    ...header,
    report_config: configFile,
    config_sha256: configSha,
    framework: config.framework,
    previous_report: previous
      ? { report_id: previous.doc.report_id ?? null, data_url: blobUrl(previous.path, { env }) }
      : null,
    inputs,
    scope,
    requirements,
    summary,
    notes,
    history: mergeHistory(previous?.doc.history, historyEntry(month, summary, requirements)),
    catalogue: merged.catalogue,
    results,
    skipped: merged.skipped,
    errors,
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

function logReport(log, data, warnings) {
  log.info(`Report: ${data.framework.title} (${data.report_id})`);
  log.info('Inputs:');
  const width = Math.max(...data.inputs.map(i => i.file.length));
  for (const input of data.inputs) {
    const detail = input.status === 'ok'
      ? `ok (${input.counts.results} results, ${input.counts.skipped} skipped, ${input.counts.errors} errors)`
      : [input.status, ...(input.problems ?? [])].join(': ');
    log.info(`  ${input.file.padEnd(width)}  ${detail}`);
  }
  log.info(`Scope: ${data.scope.active.length} active, ${data.scope.archived.length} archived repositories`);
  const byStatus = data.summary.requirements_by_status;
  log.info(`Requirements: ${STATUSES.map(s => `${byStatus[s]} ${s}`).join(', ')}`);
  for (const r of data.requirements) {
    const counts = r.repositories ? ` ${r.coverage ?? '–'}% (${r.repositories.passing}/${r.repositories.applicable}, na ${r.repositories.not_applicable}, no data ${r.repositories.no_data})` : '';
    log.debug(`  ${r.id} ${r.status}${counts}`);
  }
  const { compliance_pct: pct, checks_passed: passed, checks_evaluated: evaluated, failing_repositories: failing } = data.summary;
  log.info(`Compliance: ${pct ?? '–'}% (${passed} of ${evaluated} checks passed), ${failing} repositories with findings`);
  const months = data.history.length;
  log.info(`History: ${months} month${months === 1 ? '' : 's'} (previous report: ${data.previous_report?.report_id ?? 'none'})`);
  for (const warning of warnings) log.info(`Warning: ${warning}`);
}

/** The data-health warnings: inputs missing or invalid, errors, unknown checks. */
export function dataHealth(data, unknown) {
  const warnings = [];
  const bad = data.inputs.filter(i => i.status !== 'ok');
  if (bad.length > 0) warnings.push(`data health: ${bad.map(i => `${i.file} ${i.status}`).join(', ')}`);
  if (data.errors.length > 0) warnings.push(`data health: ${data.errors.length} error${data.errors.length === 1 ? '' : 's'} (no data)`);
  for (const check of unknown) warnings.push(`mapped check ${check} is in no tool file`);
  return warnings;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger, git = simpleGit, now = new Date() } = {}) {
  const { org, configPath, debug, dir, reports } = parseCli(argv, { stringFlags: ['dir', 'reports'] });
  if (!configPath) throw new ScriptError('--config is required');
  if (!dir) throw new ScriptError('--dir is required');
  const log = logger ?? createLogger({ debug });

  const config = await loadReportConfig(configPath);
  const { inputs, docs } = await readInputs(path.resolve(dir), config.inputs, org);
  const { notes, error: notesError } = config.notes ? await readNotes(config.notes) : { notes: null, error: null };
  const header = { run_at: isoSeconds(now), org, ospo_sha: await resolveOspoSha(env, git), run_url: runUrl(env) };
  const reportsDir = path.resolve(reports ?? DEFAULT_REPORTS_PATH);
  const previous = await readPreviousReport(reportsDir, config.key, header.run_at.slice(0, 7));
  const data = buildData({
    config,
    configFile: repoRelative(configPath),
    configSha: sha256(await readFile(configPath)),
    inputs,
    docs,
    previous,
    notes,
    notesError,
    header,
    env,
  });

  logReport(log, data, dataHealth(data, unknownChecks(mappedChecks(config.requirements), data.catalogue, inputs)));
  const monthDir = path.join(reportsDir, data.run_at.slice(0, 7));
  const dataFile = path.join(monthDir, `${config.key}-data.json`);
  const htmlFile = path.join(monthDir, `${config.key}-report.html`);
  await writeJsonReport(path.resolve(dataFile), data);
  await writeFile(path.resolve(htmlFile), renderHtml(data, await loadTemplate()));
  log.info(`\nJSON written to ${dataFile}`);
  log.info(`HTML written to ${htmlFile}`);
  return 0;
}

runIfMain(import.meta.url, run);
