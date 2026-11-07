// Small output abstraction so scripts never write to the console directly.
// Tests pass their own `out`/`err` streams to capture output (see test/helpers/memory_logger.js).

export function createLogger({ debug = false, out = process.stdout, err = process.stderr } = {}) {
  const write = text => out.write(text);
  return {
    debugEnabled: debug,
    write,
    /** Like console.log: joins the parts with a space and adds a newline. */
    info: (...parts) => write(`${parts.join(' ')}\n`),
    /** Same as info, but only when --debug is set. */
    debug: (...parts) => {
      if (debug) write(`${parts.join(' ')}\n`);
    },
    error: (...parts) => err.write(`${parts.join(' ')}\n`),
    /** Prints "label... ", runs fn, then prints "✓" (or "✗" if fn throws). */
    async step(label, fn) {
      write(`${label}... `);
      try {
        const result = await fn();
        write('✓\n');
        return result;
      } catch (error) {
        write('✗\n');
        throw error;
      }
    },
  };
}
