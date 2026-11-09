import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { INDEX_FILE, SCORECARD_URL, describeReport, previewUrl, renderIndex, run, scanReports, titleOf } from '../reports_index.js';
import { ScriptError } from '../lib/cli.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

const org = 'test-org';
const html = title => `<!doctype html><html><head><title>${title}</title></head><body></body></html>`;

let tmpDir;
before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'reports-index-test-')); });
after(async () => { await rm(tmpDir, { recursive: true }); });

/** A reports folder with files { 'YYYY-MM/name': content } in a fresh directory. */
async function reportsFolder(name, files) {
  const dir = path.join(tmpDir, name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

const FILES = {
  '2026-10/bsi-report.html': html('BSI TR-03185 Chapter 2 Compliance Report · test-org · 2026-10'),
  '2026-10/bsi-data.json': '{}',
  '2026-11/bsi-report.html': html('BSI TR-03185 Chapter 2 Compliance Report · test-org · 2026-11'),
  '2026-11/bsi-data.json': '{"framework":{"url":"https://example.org/bsi"}}',
  '2026-11/scorecard-report.html': html('OpenSSF Scorecard Report · test-org · 2026-11'),
  '2026-11/scorecard-data.json': '{}',
  '2026-11/notes.txt': 'not a report',
  '2026-09/only-data.json': '{}',
  'drafts/x-report.html': html('Not a month folder'),
  'README.md': 'old index',
};

describe('titleOf', () => {
  it('takes the name before organisation and month and unescapes it', () => {
    assert.equal(titleOf(html('Q&amp;A &lt;Report&gt; &quot;x&quot; &#39;y&#39; · org · 2026-11')), `Q&A <Report> "x" 'y'`);
  });

  it('is null without a title', () => {
    assert.equal(titleOf('<html></html>'), null);
    assert.equal(titleOf(html('  ')), null);
  });
});

describe('scanReports', () => {
  it('lists the month folders with reports, latest first', async () => {
    const dir = await reportsFolder('scan', FILES);
    assert.deepEqual(await scanReports(dir), [
      {
        month: '2026-11',
        reports: [
          { key: 'bsi', title: 'BSI TR-03185 Chapter 2 Compliance Report', html: 'bsi-report.html', url: 'https://example.org/bsi' },
          { key: 'scorecard', title: 'OpenSSF Scorecard Report', html: 'scorecard-report.html' },
        ],
      },
      { month: '2026-10', reports: [{ key: 'bsi', title: 'BSI TR-03185 Chapter 2 Compliance Report', html: 'bsi-report.html' }] },
    ]);
  });

  it('falls back to the key without a title', async () => {
    const dir = await reportsFolder('fallback', { '2026-11/x-report.html': '<html></html>' });
    assert.deepEqual(await scanReports(dir), [{ month: '2026-11', reports: [{ key: 'x', title: 'x', html: 'x-report.html' }] }]);
  });

  it('is empty for a missing folder', async () => {
    assert.deepEqual(await scanReports(path.join(tmpDir, 'missing')), []);
  });

  it('throws other read errors', async () => {
    const file = await reportsFolder('file', { 'plain.txt': 'x' });
    await assert.rejects(scanReports(path.join(file, 'plain.txt')), { code: 'ENOTDIR' });
  });
});

describe('previewUrl', () => {
  it('links the blob on main of the default repository through htmlpreview', () => {
    assert.equal(previewUrl('2026-11', 'bsi-report.html'), 'https://htmlpreview.github.io/?https://github.com/allianz/ospo/blob/main/reports/2026-11/bsi-report.html');
  });

  it('uses the repository of the workflow run', () => {
    assert.equal(
      previewUrl('2026-11', 'bsi-report.html', { GITHUB_REPOSITORY: 'acme/ospo', GITHUB_SERVER_URL: 'https://github.example' }),
      'https://htmlpreview.github.io/?https://github.example/acme/ospo/blob/main/reports/2026-11/bsi-report.html',
    );
  });
});

describe('renderIndex', () => {
  it('says so when there are no reports', () => {
    const text = renderIndex([], { org });
    assert.match(text, /No reports yet\./);
    assert.doesNotMatch(text, /## Compliance Reports/);
  });

  it('has no earlier months section for a single month and escapes titles', () => {
    const text = renderIndex([{ month: '2026-11', reports: [{ key: 'x', title: 'A [b] *c*', html: 'x-report.html' }] }], { org });
    assert.ok(text.includes('| A \\[b\\] \\*c\\* | [Report](https://htmlpreview.github.io/?https://github.com/allianz/ospo/blob/main/reports/2026-11/x-report.html) |\n'));
    assert.doesNotMatch(text, /## Earlier months/);
  });
});

describe('guideline links', () => {
  it('ignores data files that are unreadable or have no framework url', async () => {
    const dir = await reportsFolder('urls', {
      '2026-11/a-report.html': html('A · o · 2026-11'), '2026-11/a-data.json': 'not json',
      '2026-11/b-report.html': html('B · o · 2026-11'), '2026-11/b-data.json': '{"framework":{}}',
      '2026-11/c-report.html': html('C · o · 2026-11'),
    });
    const [{ reports }] = await scanReports(dir);
    assert.ok(reports.every(r => !('url' in r)));
  });

  it('links the guideline on the left, the scorecard to the OpenSSF project', () => {
    const reports = [
      { key: 'bsi', title: 'BSI Compliance Report', html: 'bsi-report.html', url: 'https://example.org/bsi' },
      { key: 'scorecard', title: 'OpenSSF Scorecard Report', html: 'scorecard-report.html' },
      { key: 'x', title: 'X Compliance Report', html: 'x-report.html' },
    ];
    const text = renderIndex([{ month: '2026-11', reports }], { org });
    assert.match(text, /\| \[BSI\]\(https:\/\/example\.org\/bsi\) \| /);
    assert.ok(text.includes(`| [OpenSSF Scorecard](${SCORECARD_URL}) | `));
    assert.match(text, /\| X \| /);
  });
});

describe('describeReport', () => {
  it('splits compliance reports into guideline and kind', () => {
    assert.deepEqual(describeReport({ key: 'bsi', title: 'BSI TR-03185 Chapter 2 Compliance Report' }), { guideline: 'BSI TR-03185 Chapter 2', kind: 'Compliance Report' });
  });

  it('calls the scorecard report a security score report', () => {
    assert.deepEqual(describeReport({ key: 'scorecard', title: 'OpenSSF Scorecard Report' }), { guideline: 'OpenSSF Scorecard', kind: 'Security Score Report' });
  });

  it('keeps a title without report suffix', () => {
    assert.deepEqual(describeReport({ key: 'x', title: 'Other' }), { guideline: 'Other', kind: 'Report' });
  });
});

describe('renderIndex table', () => {
  it('puts the community report outside the table', () => {
    const reports = [
      { key: 'bsi', title: 'BSI Compliance Report', html: 'bsi-report.html' },
      { key: 'community', title: 'Open Source Community Report', html: 'community-report.html' },
    ];
    const text = renderIndex([{ month: '2026-11', reports }], { org });
    assert.match(text, /\| BSI \| \[Compliance Report\]\(.*bsi-report\.html\) \|\n/);
    assert.doesNotMatch(text, /\| .*community/);
    assert.match(text, /## Compliance Reports: 2026-11\n/);
    assert.match(text, /## Other Reports: 2026-11\n\n\[Open Source Community Report\]\(.*community-report\.html\)\n/);
  });

  it('shows only the community report without a table', () => {
    const text = renderIndex([{ month: '2026-11', reports: [{ key: 'community', title: 'C', html: 'community-report.html' }] }], { org });
    assert.doesNotMatch(text, /Guideline/);
    assert.doesNotMatch(text, /## Compliance Reports/);
    assert.match(text, /## Other Reports: 2026-11/);
  });
});

describe('run', () => {
  it('writes the README of the reports folder', async (t) => {
    const dir = await reportsFolder('run', FILES);
    const logger = createMemoryLogger({ debug: true });
    assert.equal(await run({ argv: ['--org', org, '--reports', dir, '--debug'], logger }), 0);
    const text = await readFile(path.join(dir, INDEX_FILE), 'utf8');
    t.assert.snapshot(text);
    t.assert.snapshot(logger.output().replaceAll(dir, '<reports>'));
  });

  it('creates a missing reports folder with an empty index', async () => {
    const dir = path.join(tmpDir, 'new');
    const logger = createMemoryLogger();
    assert.equal(await run({ argv: ['--org', org, '--reports', dir], logger }), 0);
    assert.match(await readFile(path.join(dir, INDEX_FILE), 'utf8'), /No reports yet\./);
    assert.match(logger.output(), /Reports index: 0 months\n/);
  });

  it('counts a single month', async () => {
    const dir = await reportsFolder('single', { '2026-11/x-report.html': html('X · o · 2026-11') });
    const logger = createMemoryLogger();
    await run({ argv: ['--org', org, '--reports', dir], logger });
    assert.match(logger.output(), /Reports index: 1 month, latest 2026-11\n/);
  });

  it('requires --org', async () => {
    await assert.rejects(run({ argv: ['--reports', tmpDir] }), ScriptError);
  });
});
