import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ScriptError, executeMain, parseCli, resolveToken, runIfMain } from '../../lib/cli.js';

const memoryStream = () => {
  const chunks = [];
  return { write: text => chunks.push(text), text: () => chunks.join('') };
};

describe('parseCli', () => {
  it('parses the common flags and resolves --config', () => {
    const args = parseCli(['--org', 'acme', '--config', 'x.yaml', '--dry-run', '--debug'], { defaultConfigPath: '/default.yaml' });
    assert.deepEqual(args, { org: 'acme', configPath: path.resolve('x.yaml'), dryRun: true, debug: true });
  });

  it('uses the default config path and false booleans', () => {
    assert.deepEqual(parseCli(['--org', 'acme'], { defaultConfigPath: '/default.yaml' }), {
      org: 'acme',
      configPath: '/default.yaml',
      dryRun: false,
      debug: false,
    });
  });

  it('returns extra flags in camelCase', () => {
    const args = parseCli(['--org', 'acme', '--skip-team-sync'], { flags: ['skip-team-sync', 'skip-custom-role'] });
    assert.equal(args.skipTeamSync, true);
    assert.equal(args.skipCustomRole, false);
  });

  it('returns string flags in camelCase, undefined when absent', () => {
    const args = parseCli(['--org', 'acme', '--json', 'out/x.json'], { stringFlags: ['json', 'out-dir'] });
    assert.equal(args.json, 'out/x.json');
    assert.equal(args.outDir, undefined);
    assert.equal(parseCli(['--org', 'acme'], { stringFlags: ['json'] }).json, undefined);
  });

  it('rejects a string flag without a value', () => {
    assert.throws(() => parseCli(['--org', 'acme', '--json'], { stringFlags: ['json'] }), ScriptError);
  });

  it('rejects --json when the script does not support it', () => {
    assert.throws(() => parseCli(['--org', 'acme', '--json', 'x.json']), ScriptError);
  });

  it('requires --org', () => {
    assert.throws(() => parseCli([]), { constructor: ScriptError, message: '--org is required' });
  });

  it('rejects unknown flags and positional arguments', () => {
    assert.throws(() => parseCli(['--org', 'acme', '--nope']), ScriptError);
    assert.throws(() => parseCli(['--org', 'acme', 'extra']), ScriptError);
  });
});

describe('resolveToken', () => {
  it('prefers GITHUB_TOKEN and falls back to GH_TOKEN', () => {
    assert.equal(resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }), 'a');
    assert.equal(resolveToken({ GH_TOKEN: 'b' }), 'b');
  });

  it('throws when neither is set', () => {
    assert.throws(() => resolveToken({}), { constructor: ScriptError, message: /GITHUB_TOKEN \(or GH_TOKEN\)/ });
  });
});

describe('executeMain', () => {
  it('passes argv/env and returns the exit code (0 by default)', async () => {
    let received;
    assert.equal(await executeMain(async opts => { received = opts; }, { argv: ['a'], env: { X: '1' } }), 0);
    assert.deepEqual(received, { argv: ['a'], env: { X: '1' } });
    assert.equal(await executeMain(async () => 3, { argv: [], env: {} }), 3);
  });

  it('prints ScriptError as "Error:" without stack', async () => {
    const err = memoryStream();
    const code = await executeMain(async () => { throw new ScriptError('bad input'); }, { argv: [], env: { DEBUG: '1' }, err });
    assert.equal(code, 1);
    assert.equal(err.text(), 'Error: bad input\n');
  });

  it('prints other errors as "Fatal error:", with the stack when DEBUG is set', async () => {
    const quiet = memoryStream();
    await executeMain(async () => { throw new Error('boom'); }, { argv: [], env: {}, err: quiet });
    assert.equal(quiet.text(), 'Fatal error: boom\n');

    const verbose = memoryStream();
    await executeMain(async () => { throw new Error('boom'); }, { argv: [], env: { DEBUG: '1' }, err: verbose });
    assert.match(verbose.text(), /^Fatal error: boom\nError: boom\n {4}at /);
  });
});

describe('runIfMain', () => {
  const scriptPath = path.resolve('some_script.js');
  const url = pathToFileURL(scriptPath).href;

  it('does nothing when the module is imported', () => {
    assert.equal(runIfMain(url, async () => assert.fail('must not run'), { argv: ['node', 'other.js'] }), false);
  });

  it('runs and exits with the exit code when the module is the entry point', async () => {
    const exited = new Promise(resolve => {
      const started = runIfMain(url, async ({ argv }) => (argv[0] === '--x' ? 7 : 0), {
        argv: ['node', scriptPath, '--x'],
        env: {},
        exit: resolve,
      });
      assert.equal(started, true);
    });
    assert.equal(await exited, 7);
  });
});
