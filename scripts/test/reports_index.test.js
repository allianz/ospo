import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { INDEX_FILE, previewUrl, renderIndex, run, scanReports, titleOf } from '../reports_index.js';
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
  '2026-10/allianz-report.html': html('Allianz Repository Standards Compliance Report · test-org · 2026-10'),
  '2026-10/allianz-data.json': '{}',
  '2026-11/allianz-report.html': html('Allianz Repository Standards Compliance Report · test-org · 2026-11'),
  '2026-11/allianz-data.json': '{"framework":{"url":"https://example.org/allianz"}}',
  '2026-11/other-report.html': html('Other Guideline Compliance Report · test-org · 2026-11'),
  '2026-11/other-data.json': '{}',
  '2026-11/notes.txt': 'not a report',
  '2026-09/only-data.json': '{}',
  'drafts/x-report.html': html('Not a month folder'),
  'README.md': 'old index',
};

describe('titleOf', () => {
  it('takes the name before organisation and month and unescapes it', () => {
    assert.equal(titleOf(html('Q&amp;A &lt;Report&gt; &quot;x&quot; &#39;y&#39; · org · 2026-11')), `Q&A <Report> "x" 'y'`);
  });

  it('drops the suffix Compliance Report', () => {
    assert.equal(titleOf(html('Allianz Repository Standards Compliance Report · org · 2026-11')), 'Allianz Repository Standards');
    assert.equal(titleOf(html('Community Report · org · 2026-11')), 'Community Report');
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
          { key: 'allianz', title: 'Allianz Repository Standards', html: 'allianz-report.html' },
          { key: 'other', title: 'Other Guideline', html: 'other-report.html' },
        ],
      },
      { month: '2026-10', reports: [{ key: 'allianz', title: 'Allianz Repository Standards', html: 'allianz-report.html' }] },
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
    assert.equal(previewUrl('2026-11', 'allianz-report.html'), 'https://htmlpreview.github.io/?https://github.com/allianz/ospo/blob/main/reports/2026-11/allianz-report.html');
  });

  it('uses the repository of the workflow run', () => {
    assert.equal(
      previewUrl('2026-11', 'allianz-report.html', { GITHUB_REPOSITORY: 'acme/ospo', GITHUB_SERVER_URL: 'https://github.example' }),
      'https://htmlpreview.github.io/?https://github.example/acme/ospo/blob/main/reports/2026-11/allianz-report.html',
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
    assert.ok(text.includes('## Compliance Reports: 2026-11\n\n- [A \\[b\\] \\*c\\*](https://htmlpreview.github.io/?https://github.com/allianz/ospo/blob/main/reports/2026-11/x-report.html)\n'));
    assert.doesNotMatch(text, /\| /);
    assert.doesNotMatch(text, /## Earlier months/);
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
