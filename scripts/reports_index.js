#!/usr/bin/env node

// The index of the reports folder: writes reports/README.md with the reports of the latest month
// and links to all earlier months. The HTML reports are linked through htmlpreview.github.io, so
// they open rendered in the browser instead of as source on GitHub. Reads the reports folder only
// and never calls GitHub. See spec/reports_index_spec.md.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseCli, runIfMain } from './lib/cli.js';
import { blobUrl } from './lib/json_output.js';
import { createLogger } from './lib/logger.js';
import { DEFAULT_REPORTS_PATH, REPORTS_DIR } from './lib/report_files.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const TOOL = 'reports_index';
export const INDEX_FILE = 'README.md';
export const PREVIEW_URL = 'https://htmlpreview.github.io/?';
const MONTH = /^\d{4}-\d{2}$/;
const REPORT_FILE = /^(.+)-report\.html$/;
export const SCORECARD_URL = 'https://github.com/ossf/scorecard/blob/main/docs/checks.md';

const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const escapeMarkdown = text => text.replace(/([\\[\]*_`])/g, '\\$1');

// ── Scan ─────────────────────────────────────────────────────────────────────

/**
 * The name of a report from the <title> of its HTML file, without the organisation and month
 * ("BSI TR-03185 Chapter 2 Compliance Report · allianz · 2026-11" → "BSI TR-03185 Chapter 2 Compliance Report").
 * Null when the file has no title.
 */
export function titleOf(html) {
  const match = /<title>([^<]*)<\/title>/.exec(html);
  const title = match ? unescapeHtml(match[1]).split(' · ')[0].trim() : '';
  return title || null;
}

/** The guideline URL (`framework.url`) of a `<key>-data.json`; null when the file is missing, unreadable or has none. */
async function guidelineUrlOf(file) {
  try {
    const url = JSON.parse(await readFile(file, 'utf8')).framework?.url;
    return typeof url === 'string' && url ? url : null;
  } catch {
    return null;
  }
}

/**
 * The month folders of the reports directory with their reports, latest month first:
 * `[{ month, reports: [{ key, title, html, url? }] }]`, `url` being the guideline URL from the report's data file. Folders without a `*-report.html` are left out.
 */
export async function scanReports(reportsDir) {
  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const months = entries.filter(e => e.isDirectory() && MONTH.test(e.name)).map(e => e.name).sort().reverse();
  const result = [];
  for (const month of months) {
    const files = await readdir(path.join(reportsDir, month));
    const reports = [];
    for (const html of files.filter(f => REPORT_FILE.test(f)).sort()) {
      const key = REPORT_FILE.exec(html)[1];
      const title = titleOf(await readFile(path.join(reportsDir, month, html), 'utf8')) ?? key;
      const url = await guidelineUrlOf(path.join(reportsDir, month, `${key}-data.json`));
      reports.push({ key, title, html, ...(url && { url }) });
    }
    if (reports.length > 0) result.push({ month, reports });
  }
  return result;
}

// ── Render ───────────────────────────────────────────────────────────────────

/** The htmlpreview link of an HTML report on main: renders the self-contained file in the browser. */
export function previewUrl(month, file, env = {}) {
  return `${PREVIEW_URL}${blobUrl(`${REPORTS_DIR}/${month}/${file}`, { env })}`;
}

const reportLink = (month, report, env) => `[${escapeMarkdown(report.title)}](${previewUrl(month, report.html, env)})`;

const COMPLIANCE_SUFFIX = ' Compliance Report';
const REPORT_SUFFIX = ' Report';
const COMMUNITY_KEY = 'community';

/**
 * Splits a report into the guideline it checks and the kind of report, so the table does not repeat
 * words in both columns: "BSI TR-03185 Chapter 2 Compliance Report" → guideline "BSI TR-03185 Chapter 2",
 * kind "Compliance Report". The scorecard report is shown as "Security Score Report".
 */
export function describeReport({ key, title }) {
  if (title.endsWith(COMPLIANCE_SUFFIX)) return { guideline: title.slice(0, -COMPLIANCE_SUFFIX.length), kind: 'Compliance Report' };
  const guideline = title.endsWith(REPORT_SUFFIX) ? title.slice(0, -REPORT_SUFFIX.length) : title;
  return { guideline, kind: key === 'scorecard' ? 'Security Score Report' : 'Report' };
}

/** The latest month: `## Compliance Reports` with the table guideline → report, then `## Other Reports` with the community report. */
function latestSection({ month, reports }, env) {
  const community = reports.filter(r => r.key === COMMUNITY_KEY);
  const rows = reports.filter(r => r.key !== COMMUNITY_KEY).map(r => {
    const { guideline, kind } = describeReport(r);
    const url = r.url ?? (r.key === 'scorecard' ? SCORECARD_URL : null);
    const left = url ? `[${escapeMarkdown(guideline)}](${url})` : escapeMarkdown(guideline);
    return `| ${left} | [${kind}](${previewUrl(month, r.html, env)}) |`;
  });
  const lines = [];
  if (rows.length > 0) lines.push(`## Compliance Reports: ${month}`, '', '| Guideline | Report |', '| --- | --- |', ...rows, '');
  if (community.length > 0) lines.push(`## Other Reports: ${month}`, '', ...community.map(r => reportLink(month, r, env)), '');
  return lines;
}

/** reports/README.md for the scanned month folders (pure). */
export function renderIndex(months, { org, env = {} }) {
  const lines = [
    '# Reports',
    '',
    `Monthly OSPO reports of the GitHub organisation \`${org}\`, one folder per month.`,
    '',
    `<!-- Generated by scripts/${TOOL}.js (make create_reports). Do not edit by hand. -->`,
    '',
  ];
  if (months.length === 0) {
    lines.push('No reports yet.', '');
    return lines.join('\n');
  }
  const [latest, ...earlier] = months;
  lines.push(...latestSection(latest, env));
  if (earlier.length > 0) {
    lines.push('## Earlier months', '');
    for (const { month, reports } of earlier) {
      lines.push(`- [${month}](${month}/): ${reports.map(r => reportLink(month, r, env)).join(' · ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run({ argv = [], env = {}, logger } = {}) {
  const { org, debug, reports } = parseCli(argv, { stringFlags: ['reports'] });
  const log = logger ?? createLogger({ debug });

  const reportsDir = path.resolve(reports ?? DEFAULT_REPORTS_PATH);
  const months = await scanReports(reportsDir);
  log.info(`Reports index: ${months.length} month${months.length === 1 ? '' : 's'}${months.length > 0 ? `, latest ${months[0].month}` : ''}`);
  for (const { month, reports: list } of months) log.debug(`  ${month}: ${list.map(r => r.key).join(', ')}`);

  const file = path.join(reportsDir, INDEX_FILE);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(file, renderIndex(months, { org, env }));
  log.info(`Index written to ${file}`);
  return 0;
}

runIfMain(import.meta.url, run);
