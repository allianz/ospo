/** Prints a title underlined with ─ of the same length. */
export function printHeading(logger, title) {
  logger.info(title);
  logger.info('─'.repeat(title.length));
}

/** Prints a blank line, heading and lines; nothing at all if there are no lines. */
export function printSection(logger, title, lines) {
  if (lines.length === 0) return;
  logger.info('');
  printHeading(logger, title);
  for (const line of lines) logger.info(line);
}

/** Prints a "– name" list section (used for skipped repositories). */
export function printNameList(logger, title, names) {
  printSection(logger, title, names.map(name => `– ${name}`));
}

/**
 * Prints the dry-run summary of issue operations recorded in plan.issueOps:
 *   ──── Dry-run: 1 would be created, 0 would be updated, 2 would be closed ────
 * `subject` is inserted after the first count (license_scan says "1 issue would be created").
 */
export function printIssueDryRunSummary(logger, plan, { subject = '' } = {}) {
  if (!plan.dryRun || plan.issueOps.length === 0) return;
  const byAction = action => plan.issueOps.filter(op => op.action === action);
  const creates = byAction('create');
  const updates = byAction('update');
  const closes = byAction('close');
  const noun = subject ? `${subject} ` : '';

  logger.info('');
  logger.info(
    `──── Dry-run: ${creates.length} ${noun}would be created, ${updates.length} would be updated, ${closes.length} would be closed ────`,
  );
  for (const { repo } of creates) logger.info(`  ✉️   create  ${repo}`);
  for (const { number, repo } of updates) logger.info(`  ✏️   update  #${number}  ${repo}`);
  for (const { number, repo } of closes) logger.info(`  ✔️   close   #${number}  ${repo}`);
}
