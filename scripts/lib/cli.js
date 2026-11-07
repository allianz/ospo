import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** An expected failure with a clear message (bad flags, missing token, missing repo). Printed as "Error: …" without a stack. */
export class ScriptError extends Error {}

const camelCase = flag => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Parses the common CLI flags (--org, --config, --dry-run, --debug) plus any
 * extra boolean `flags` and string-valued `stringFlags` (e.g. --json <file>).
 * Unknown flags and positional arguments are rejected.
 * Extra flags are returned in camelCase (--skip-team-sync → skipTeamSync); an
 * absent string flag is undefined.
 */
export function parseCli(argv, { defaultConfigPath, flags = [], stringFlags = [] } = {}) {
  const options = {
    org: { type: 'string' },
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false },
  };
  for (const flag of flags) options[flag] = { type: 'boolean', default: false };
  for (const flag of stringFlags) options[flag] = { type: 'string' };

  let values;
  try {
    ({ values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new ScriptError(err.message);
  }
  if (!values.org) throw new ScriptError('--org is required');

  const result = {
    org: values.org,
    configPath: values.config ? path.resolve(values.config) : defaultConfigPath,
    dryRun: values['dry-run'],
    debug: values.debug,
  };
  for (const flag of [...flags, ...stringFlags]) result[camelCase(flag)] = values[flag];
  return result;
}

export function resolveToken(env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new ScriptError('GITHUB_TOKEN (or GH_TOKEN) environment variable is not set');
  return token;
}

/** Runs a script's run() and turns errors into an exit code, printing them like the scripts always did. */
export async function executeMain(run, { argv, env, err = process.stderr }) {
  try {
    return (await run({ argv, env })) ?? 0;
  } catch (error) {
    if (error instanceof ScriptError) {
      err.write(`Error: ${error.message}\n`);
    } else {
      err.write(`Fatal error: ${error.message}\n`);
      if (env.DEBUG) err.write(`${error.stack}\n`);
    }
    return 1;
  }
}

/**
 * Calls run() only when the calling module is the entry point (not when imported by tests).
 * Exits explicitly at the end, so open handles (keep-alive sockets) never delay the exit.
 */
export function runIfMain(importMetaUrl, run, { argv = process.argv, env = process.env, exit = code => process.exit(code) } = {}) {
  if (argv[1] !== fileURLToPath(importMetaUrl)) return false;
  executeMain(run, { argv: argv.slice(2), env }).then(exit);
  return true;
}
