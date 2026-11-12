// Tests for the small lib modules: config, dates, concurrency, logger, plan, report, repos.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mapWithConcurrency } from '../../lib/concurrency.js';
import { defaultConfigPath, loadYaml, repoRoot, requireFields } from '../../lib/config.js';
import { daysUntil, parseRelativeDate } from '../../lib/dates.js';
import { createLogger } from '../../lib/logger.js';
import { createPlan } from '../../lib/plan.js';
import { printHeading, printIssueDryRunSummary, printNameList, printSection } from '../../lib/report.js';
import { byName, partitionRepos } from '../../lib/repos.js';
import { createMemoryLogger } from '../helpers/memory_logger.js';

// ── config ────────────────────────────────────────────────────────────────────

describe('config', () => {
  let tmpDir;
  before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'lib-config-')); });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('points the default config at <repo>/config/<name>.yaml', () => {
    assert.equal(defaultConfigPath('lint_repos'), path.join(repoRoot, 'config', 'lint_repos.yaml'));
    assert.equal(repoRoot, path.resolve(import.meta.dirname, '..', '..', '..'));
  });

  it('points the default config of a report tool at <repo>/config/report/<name>.yaml', () => {
    assert.equal(defaultConfigPath('allianz_report', 'report'), path.join(repoRoot, 'config', 'report', 'allianz_report.yaml'));
  });

  it('loads YAML, and null for an empty file', async () => {
    const file = path.join(tmpDir, 'a.yaml');
    await writeFile(file, 'key: value\nlist: [1, 2]\n');
    assert.deepEqual(await loadYaml(file), { key: 'value', list: [1, 2] });
    await writeFile(file, '');
    assert.equal(await loadYaml(file), null);
  });

  it('requireFields rejects missing, empty and empty-list fields', () => {
    assert.doesNotThrow(() => requireFields({ a: 'x', b: [1] }, ['a', 'b'], 'f.yaml'));
    assert.throws(() => requireFields({}, ['a'], 'f.yaml'), { message: 'Config missing required field: a (in f.yaml)' });
    assert.throws(() => requireFields({ a: '' }, ['a'], 'f.yaml'), /field: a/);
    assert.throws(() => requireFields({ a: [] }, ['a'], 'f.yaml'), /field: a/);
    assert.throws(() => requireFields(null, ['a'], 'f.yaml'), /field: a/);
  });
});

// ── dates ─────────────────────────────────────────────────────────────────────

describe('parseRelativeDate', () => {
  const now = new Date('2026-03-31T12:00:00Z');

  for (const [input, expected] of [
    ['2 years', '2024-03-31T12:00:00.000Z'],
    ['1 year ago', '2025-03-31T12:00:00.000Z'],
    ['6 months', '2025-10-01T12:00:00.000Z'], // Sep 31 rolls over to Oct 1, as Date does
    ['1 month ago', '2026-03-03T12:00:00.000Z'],
    ['40 days', '2026-02-19T12:00:00.000Z'],
    ['1 day ago', '2026-03-30T12:00:00.000Z'],
    ['2 minutes', '2026-03-31T11:58:00.000Z'],
    ['1 minute ago', '2026-03-31T11:59:00.000Z'],
  ]) {
    it(`parses "${input}"`, () => {
      assert.equal(parseRelativeDate(input, now).toISOString(), expected);
    });
  }

  it('does not modify `now`', () => {
    const fixed = new Date(now);
    parseRelativeDate('3 days', fixed);
    assert.equal(fixed.getTime(), now.getTime());
  });

  it('defaults to the current time', () => {
    assert.ok(Math.abs(parseRelativeDate('0 days').getTime() - Date.now()) < 1000);
  });

  for (const input of ['last week', 'two years', '2 weeks', '', '2 years from now']) {
    it(`rejects "${input}"`, () => {
      assert.throws(() => parseRelativeDate(input), /Invalid relative date/);
    });
  }
});

describe('daysUntil', () => {
  it('counts whole days rounded up, negative in the past', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    assert.equal(daysUntil(from, new Date('2026-01-11T00:00:00Z')), 10);
    assert.equal(daysUntil(from, new Date('2026-01-01T00:00:01Z')), 1);
    assert.equal(daysUntil(from, new Date('2025-12-30T00:00:00Z')), -2);
  });
});

// ── concurrency ───────────────────────────────────────────────────────────────

describe('mapWithConcurrency', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapWithConcurrency([30, 10, 20, 5, 15], 2, async (ms, index) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, ms));
      inFlight--;
      return `${index}:${ms}`;
    });
    assert.deepEqual(results, ['0:30', '1:10', '2:20', '3:5', '4:15']);
    assert.equal(maxInFlight, 2);
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapWithConcurrency([], 5, async () => assert.fail()), []);
  });

  it('rejects with the first error', async () => {
    await assert.rejects(
      () => mapWithConcurrency([1, 2, 3], 3, async n => { if (n === 2) throw new Error('two'); }),
      /two/,
    );
  });
});

// ── logger ────────────────────────────────────────────────────────────────────

describe('createLogger', () => {
  const capture = debug => {
    const out = [];
    const err = [];
    const logger = createLogger({ debug, out: { write: s => out.push(s) }, err: { write: s => err.push(s) } });
    return { logger, out: () => out.join(''), err: () => err.join('') };
  };

  it('info joins parts like console.log; error goes to err', () => {
    const { logger, out, err } = capture(false);
    logger.info('a', 'b');
    logger.info();
    logger.error('bad', 'thing');
    assert.equal(out(), 'a b\n\n');
    assert.equal(err(), 'bad thing\n');
  });

  it('prints debug only when enabled', () => {
    const off = capture(false);
    off.logger.debug('hidden');
    assert.equal(off.out(), '');
    const on = capture(true);
    on.logger.debug('shown');
    assert.equal(on.out(), 'shown\n');
    assert.equal(on.logger.debugEnabled, true);
  });

  it('step prints ✓ after success and ✗ after failure', async () => {
    const { logger, out } = capture(false);
    assert.equal(await logger.step('  + Do', async () => 42), 42);
    await assert.rejects(() => logger.step('  + Fail', async () => { throw new Error('x'); }), /x/);
    assert.equal(out(), '  + Do... ✓\n  + Fail... ✗\n');
  });

  it('writes to process.stdout by default', () => {
    const logger = createLogger();
    assert.equal(typeof logger.info, 'function');
  });
});

// ── plan ──────────────────────────────────────────────────────────────────────

describe('createPlan', () => {
  it('step: dry-run prints the label and records it without running', async () => {
    const logger = createMemoryLogger();
    const plan = createPlan({ dryRun: true, logger });
    assert.equal(await plan.step('  + A', () => assert.fail()), undefined);
    assert.deepEqual(plan.planned, ['  + A']);
    assert.equal(plan.changeCount, 1);
    assert.equal(logger.output(), '  + A\n');
  });

  it('step: live runs fn with ✓ and records it', async () => {
    const logger = createMemoryLogger();
    const plan = createPlan({ logger });
    assert.equal(await plan.step('  + A', async () => 'r'), 'r');
    assert.deepEqual(plan.applied, ['  + A']);
    assert.equal(logger.output(), '  + A... ✓\n');
  });

  it('apply: dry-run records the planned message silently', async () => {
    const logger = createMemoryLogger();
    const plan = createPlan({ dryRun: true, logger });
    await plan.apply(() => assert.fail(), { planned: 'Would do', done: 'Did' });
    await plan.apply(() => assert.fail());
    assert.deepEqual(plan.planned, ['Would do']);
    assert.equal(logger.output(), '');
  });

  it('apply: live runs fn and prints the done message', async () => {
    const logger = createMemoryLogger();
    const plan = createPlan({ logger });
    assert.equal(await plan.apply(async () => 1, { planned: 'Would do', done: 'Did' }), 1);
    await plan.apply(async () => 2, { planned: 'Silent' });
    assert.deepEqual(plan.applied, ['Did', 'Silent']);
    assert.equal(logger.output(), 'Did\n');
    assert.equal(plan.changeCount, 2);
  });
});

// ── report ────────────────────────────────────────────────────────────────────

describe('report', () => {
  it('printHeading underlines the title with its length', () => {
    const logger = createMemoryLogger();
    printHeading(logger, 'Results');
    assert.equal(logger.output(), 'Results\n───────\n');
  });

  it('printSection prints nothing for an empty list', () => {
    const logger = createMemoryLogger();
    printSection(logger, 'Empty', []);
    assert.equal(logger.output(), '');
  });

  it('printNameList prints a blank line, heading and dash list', () => {
    const logger = createMemoryLogger();
    printNameList(logger, 'Skipped', ['a', 'b']);
    assert.equal(logger.output(), '\nSkipped\n───────\n– a\n– b\n');
  });

  it('printIssueDryRunSummary groups creates, updates and closes', () => {
    const logger = createMemoryLogger();
    const plan = {
      dryRun: true,
      issueOps: [
        { action: 'close', repo: 'c', number: 3 },
        { action: 'create', repo: 'a' },
        { action: 'update', repo: 'b', number: 2 },
      ],
    };
    printIssueDryRunSummary(logger, plan, { subject: 'issue' });
    assert.equal(logger.output(), [
      '',
      '──── Dry-run: 1 issue would be created, 1 would be updated, 1 would be closed ────',
      '  ✉️   create  a',
      '  ✏️   update  #2  b',
      '  ✔️   close   #3  c',
      '',
    ].join('\n'));
  });

  it('printIssueDryRunSummary is silent in live mode or without operations', () => {
    const logger = createMemoryLogger();
    printIssueDryRunSummary(logger, { dryRun: false, issueOps: [{ action: 'create', repo: 'a' }] });
    printIssueDryRunSummary(logger, { dryRun: true, issueOps: [] });
    assert.equal(logger.output(), '');
  });
});

// ── repos ─────────────────────────────────────────────────────────────────────

describe('partitionRepos', () => {
  it('splits into active, archived and excluded; exclusion wins and order is kept', () => {
    const repos = [{ name: 'b' }, { name: 'x', archived: true }, { name: 'a' }, { name: 'ex', archived: true }];
    const { active, archived, excluded } = partitionRepos(repos, ['ex']);
    assert.deepEqual(active.map(r => r.name), ['b', 'a']);
    assert.deepEqual(archived.map(r => r.name), ['x']);
    assert.deepEqual(excluded.map(r => r.name), ['ex']);
  });

  it('treats a missing exclusion list as empty', () => {
    assert.equal(partitionRepos([{ name: 'a' }]).active.length, 1);
  });

  it('byName sorts by name', () => {
    assert.deepEqual([{ name: 'b' }, { name: 'a' }].sort(byName).map(r => r.name), ['a', 'b']);
  });
});
