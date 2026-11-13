import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ScriptError } from '../../lib/cli.js';
import { decideIssueAction, findOpenIssue, syncIssue, syncSummaryIssue } from '../../lib/issues.js';
import { createPlan } from '../../lib/plan.js';
import { createFakeGitHub, notFound } from '../helpers/fake_github.js';
import { createMemoryLogger } from '../helpers/memory_logger.js';

const org = 'o';
const TITLE = 'Compliance';

function setup(issues = {}, { dryRun = false, failures } = {}) {
  const gh = createFakeGitHub({ issues, failures });
  const logger = createMemoryLogger();
  return { gh, logger, plan: createPlan({ dryRun, logger }) };
}

describe('findOpenIssue', () => {
  it('returns the open issue with the exact title, ignoring PRs and closed issues', async () => {
    const { gh } = setup({
      r: [
        { number: 1, title: TITLE, pull_request: {} },
        { number: 2, title: TITLE, state: 'closed' },
        { number: 3, title: `${TITLE} (old)` },
        { number: 4, title: TITLE },
      ],
    });
    assert.equal((await findOpenIssue(gh, org, 'r', TITLE)).number, 4);
  });

  it('returns null when there is none', async () => {
    const { gh } = setup();
    assert.equal(await findOpenIssue(gh, org, 'r', TITLE), null);
  });
});

describe('decideIssueAction', () => {
  it('covers all four combinations', () => {
    assert.equal(decideIssueAction(null, true), 'create');
    assert.equal(decideIssueAction({}, true), 'update');
    assert.equal(decideIssueAction({}, false), 'close');
    assert.equal(decideIssueAction(null, false), 'none');
  });
});

describe('syncIssue', () => {
  it('creates a wanted issue and records the operation', async () => {
    const { gh, plan } = setup();
    const result = await syncIssue(gh, plan, { org, repo: 'r', title: TITLE, body: 'b', wanted: true });
    assert.equal(result.action, 'create');
    assert.deepEqual(gh.state.issues.r.map(i => [i.title, i.body]), [[TITLE, 'b']]);
    assert.deepEqual(plan.issueOps, [{ action: 'create', repo: 'r', number: undefined }]);
  });

  it('updates the body of an existing issue', async () => {
    const { gh, plan } = setup({ r: [{ number: 5, title: TITLE, body: 'old' }] });
    await syncIssue(gh, plan, { org, repo: 'r', title: TITLE, body: 'new', wanted: true, label: 'custom label' });
    assert.equal(gh.state.issues.r[0].body, 'new');
    assert.deepEqual(plan.issueOps, [{ action: 'update', repo: 'custom label', number: 5 }]);
  });

  it('comments before closing when a close comment is given', async () => {
    const { gh, plan } = setup({ r: [{ number: 5, title: TITLE }] });
    await syncIssue(gh, plan, { org, repo: 'r', title: TITLE, wanted: false, closeComment: 'done' });
    assert.deepEqual(gh.writes().map(c => c.method), ['commentIssue', 'closeIssue']);
    assert.equal(gh.state.issues.r[0].state, 'closed');
  });

  it('closes without a comment when none is given', async () => {
    const { gh, plan } = setup({ r: [{ number: 5, title: TITLE }] });
    await syncIssue(gh, plan, { org, repo: 'r', title: TITLE, wanted: false });
    assert.deepEqual(gh.writes().map(c => c.method), ['closeIssue']);
  });

  it('does nothing when no issue exists and none is wanted', async () => {
    const { gh, plan } = setup();
    assert.equal((await syncIssue(gh, plan, { org, repo: 'r', title: TITLE, wanted: false })).action, 'none');
    assert.deepEqual(plan.issueOps, []);
  });

  it('records but does not apply in dry-run', async () => {
    const { gh, plan } = setup({ r: [{ number: 5, title: TITLE }] }, { dryRun: true });
    await syncIssue(gh, plan, { org, repo: 'r', title: TITLE, wanted: false, closeComment: 'x' });
    assert.deepEqual(gh.writes(), []);
    assert.deepEqual(plan.issueOps, [{ action: 'close', repo: 'r', number: 5 }]);
  });
});

describe('syncSummaryIssue', () => {
  it('creates the summary issue in the ospo repo and prints the done message with prefix', async () => {
    const { gh, plan, logger } = setup();
    await syncSummaryIssue(gh, plan, { org, title: 'Summary', body: 'rows', donePrefix: '\n' });
    assert.equal(gh.state.issues.ospo[0].title, 'Summary');
    assert.equal(logger.output(), "\nCreated OSPO summary issue in 'o/ospo'.\n");
    assert.deepEqual(plan.issueOps, [{ action: 'create', repo: 'ospo (OSPO summary)', number: undefined }]);
  });

  it('plans update and close messages in dry-run', async () => {
    const update = setup({ ospo: [{ number: 3, title: 'Summary' }] }, { dryRun: true });
    await syncSummaryIssue(update.gh, update.plan, { org, title: 'Summary', body: 'rows' });
    assert.deepEqual(update.plan.planned, ["Would update OSPO summary issue #3 in 'o/ospo'."]);

    const close = setup({ ospo: [{ number: 3, title: 'Summary' }] }, { dryRun: true });
    await syncSummaryIssue(close.gh, close.plan, { org, title: 'Summary', body: null });
    assert.deepEqual(close.plan.planned, ["Would close OSPO summary issue #3 in 'o/ospo'."]);
  });

  it('turns a 404 into a clear ScriptError', async () => {
    const { gh, plan } = setup({}, { failures: { listOpenIssues: () => notFound() } });
    await assert.rejects(() => syncSummaryIssue(gh, plan, { org, title: 'Summary', body: 'x' }), {
      constructor: ScriptError,
      message: "repository 'o/ospo' not found. The OSPO summary issue cannot be managed without this repository.",
    });
  });

  it('rethrows other errors unchanged', async () => {
    const boom = new Error('boom');
    const { gh, plan } = setup({}, { failures: { listOpenIssues: () => boom } });
    await assert.rejects(() => syncSummaryIssue(gh, plan, { org, title: 'Summary', body: 'x' }), err => err === boom);
  });
});
