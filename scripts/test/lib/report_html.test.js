import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DATA_PLACEHOLDER, TITLE_PLACEHOLDER, embedJson, loadTemplate, renderHtml, reportTitle } from '../../lib/report_html.js';

const data = {
  run_at: '2026-11-03T02:00:00Z',
  org: 'allianz',
  framework: { title: 'BSI <TR> & "Co"' },
  notes: { key_messages: ['Text with </script><script>alert(1)</script> inside'] },
};
const TEMPLATE = `<title>${TITLE_PLACEHOLDER}</title><script type="application/json" id="data.json">${DATA_PLACEHOLDER}</script>`;
const embedded = html => html.match(/<script type="application\/json" id="data.json">(.*?)<\/script>/s)[1];

describe('embedJson', () => {
  it('escapes < so the data cannot close the script tag, and stays valid JSON', () => {
    const json = embedJson(data);
    assert.ok(!json.includes('<'));
    assert.deepEqual(JSON.parse(json), data);
  });
});

describe('reportTitle', () => {
  it('names framework, organisation and month', () => {
    assert.equal(reportTitle({ ...data, framework: { title: 'BSI TR-03185 Chapter 2' } }), 'BSI TR-03185 Chapter 2 Compliance Report · allianz · 2026-11');
  });
});

describe('renderHtml', () => {
  const html = renderHtml(data, TEMPLATE);

  it('embeds data.json once, unchanged', () => {
    assert.deepEqual(JSON.parse(embedded(html)), data);
    assert.equal(html.match(/<\/script>/g).length, 1);
  });

  it('escapes the title', () => {
    assert.match(html, /<title>BSI &lt;TR&gt; &amp; &quot;Co&quot; Compliance Report · allianz · 2026-11<\/title>/);
  });

  it('keeps $ patterns in the data literally', () => {
    const special = { ...data, org: "$& $' $`" };
    assert.equal(JSON.parse(embedded(renderHtml(special, TEMPLATE))).org, "$& $' $`");
  });

  it('requires each placeholder exactly once', () => {
    assert.throws(() => renderHtml(data, `<title>${TITLE_PLACEHOLDER}</title>`), /must contain __DATA_JSON__ exactly once \(found 0\)/);
    assert.throws(() => renderHtml(data, `${TEMPLATE}${TITLE_PLACEHOLDER}`), /must contain __TITLE__ exactly once \(found 2\)/);
  });
});

describe('the report template', () => {
  it('has both placeholders once, no mock-up parts and no external resources', async () => {
    const template = await loadTemplate();
    assert.equal(template.split(DATA_PLACEHOLDER).length, 2);
    assert.equal(template.split(TITLE_PLACEHOLDER).length, 2);
    assert.doesNotMatch(template, /mock/i);
    assert.doesNotMatch(template, /<(script|link|img)[^>]+(src|href)="https?:/i);
    assert.match(template, /id="render-error"/);
    assert.match(template, /dataset\.render = 'ok'/);
  });

  it('renders a valid page for real data', async () => {
    const html = renderHtml(data, await loadTemplate());
    assert.match(html, /^<!doctype html>/);
    assert.deepEqual(JSON.parse(embedded(html)), data);
  });
});
