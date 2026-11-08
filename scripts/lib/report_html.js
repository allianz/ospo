// The HTML report: the template with data.json embedded. The page renders itself in the browser
// from the embedded data.json only. See spec/compliance_report_spec.md, section "HTML report".

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_PATH = fileURLToPath(new URL('../templates/compliance_report.html', import.meta.url));
export const DATA_PLACEHOLDER = '__DATA_JSON__';
export const TITLE_PLACEHOLDER = '__TITLE__';

export async function loadTemplate(file = TEMPLATE_PATH) {
  return readFile(file, 'utf8');
}

const escapeHtml = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** data.json as the content of a <script type="application/json">: `<` is escaped, so the data cannot close the tag. */
export function embedJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** The page title, e.g. "BSI TR-03185 Chapter 2 Compliance Report · allianz · 2026-11". */
export function reportTitle(data) {
  return `${data.framework.title} Compliance Report · ${data.org} · ${data.run_at.slice(0, 7)}`;
}

function replaceOnce(template, placeholder, value) {
  const parts = template.split(placeholder);
  if (parts.length !== 2) throw new Error(`Template must contain ${placeholder} exactly once (found ${parts.length - 1})`);
  return parts[0] + value + parts[1];
}

/** The complete HTML report for one data.json. */
export function renderHtml(data, template) {
  const withTitle = replaceOnce(template, TITLE_PLACEHOLDER, escapeHtml(reportTitle(data)));
  return replaceOnce(withTitle, DATA_PLACEHOLDER, embedJson(data));
}
