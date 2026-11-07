import { createLogger } from '../../lib/logger.js';

/** A real logger whose stdout/stderr go into memory. Use .output() / .errors() in assertions. */
export function createMemoryLogger({ debug = false } = {}) {
  const out = [];
  const err = [];
  const logger = createLogger({
    debug,
    out: { write: text => out.push(text) },
    err: { write: text => err.push(text) },
  });
  logger.output = () => out.join('');
  logger.errors = () => err.join('');
  logger.lines = () => out.join('').split('\n');
  return logger;
}
