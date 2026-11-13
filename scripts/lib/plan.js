/**
 * Central place for dry-run handling: every change a script makes goes through
 * the plan, so no script needs its own `if (dryRun) … else …` branches.
 *
 * Two output styles exist:
 * - step(label, fn): dry-run prints `label`; live prints `label... ✓` around fn (create_repos).
 * - apply(fn, { planned, done }): dry-run only records `planned`; live runs fn and prints `done` if given.
 *
 * issueOps records every issue create/update/close (dry-run and live) for the dry-run summary.
 */
export function createPlan({ dryRun = false, logger }) {
  const planned = [];
  const applied = [];
  const issueOps = [];

  return {
    dryRun,
    planned,
    applied,
    issueOps,

    /** Number of changes planned or made so far. */
    get changeCount() {
      return planned.length + applied.length;
    },

    async step(label, fn) {
      if (dryRun) {
        logger.info(label);
        planned.push(label);
        return undefined;
      }
      const result = await logger.step(label, fn);
      applied.push(label);
      return result;
    },

    async apply(fn, { planned: plannedMessage, done } = {}) {
      if (dryRun) {
        if (plannedMessage) planned.push(plannedMessage);
        return undefined;
      }
      const result = await fn();
      if (done) logger.info(done);
      applied.push(done ?? plannedMessage);
      return result;
    },
  };
}
