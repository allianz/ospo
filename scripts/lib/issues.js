import { ScriptError } from './cli.js';
import { isNotFound } from './github.js';

/** Repository that holds the OSPO summary issues. */
export const SUMMARY_REPO = 'ospo';

/** Returns the open issue (not PR) with exactly this title, or null. */
export async function findOpenIssue(gh, org, repo, title) {
  const issues = await gh.listOpenIssues(org, repo);
  return issues.find(issue => issue.title === title && !issue.pull_request) ?? null;
}

/** 'create' | 'update' | 'close' | 'none' depending on whether an issue exists and whether one is wanted. */
export function decideIssueAction(existing, wanted) {
  if (wanted) return existing ? 'update' : 'create';
  return existing ? 'close' : 'none';
}

/**
 * Makes sure exactly one open issue with `title` exists in `repo` if `wanted`, and none otherwise.
 * Existing issues get the new body; issues that are no longer wanted are closed, after posting
 * `closeComment` if one is given. Every operation is recorded in plan.issueOps under `label`.
 * `describe(action, number)` may return { planned, done } messages for the plan.
 */
export async function syncIssue(gh, plan, { org, repo, title, body, wanted, closeComment, label = repo, describe }) {
  const existing = await findOpenIssue(gh, org, repo, title);
  const action = decideIssueAction(existing, wanted);
  if (action === 'none') return { action, issue: existing };

  const number = existing?.number;
  plan.issueOps.push({ action, repo: label, number });

  const apply = {
    create: () => gh.createIssue(org, repo, { title, body }),
    update: () => gh.updateIssue(org, repo, number, { body }),
    close: async () => {
      if (closeComment) await gh.commentIssue(org, repo, number, closeComment);
      await gh.closeIssue(org, repo, number);
    },
  }[action];

  await plan.apply(apply, describe?.(action, number) ?? {});
  return { action, issue: existing };
}

/**
 * Syncs the OSPO summary issue in <org>/ospo: created or updated with `body`,
 * or closed when `body` is null. `donePrefix` is printed before the live message.
 */
export async function syncSummaryIssue(gh, plan, { org, title, body, closeComment, donePrefix = '' }) {
  const where = `'${org}/${SUMMARY_REPO}'`;
  const describe = (action, number) => ({
    create: { planned: `Would create OSPO summary issue in ${where}.`, done: `${donePrefix}Created OSPO summary issue in ${where}.` },
    update: { planned: `Would update OSPO summary issue #${number} in ${where}.`, done: `${donePrefix}Updated OSPO summary issue #${number} in ${where}.` },
    close: { planned: `Would close OSPO summary issue #${number} in ${where}.`, done: `${donePrefix}Closed OSPO summary issue #${number} in ${where}.` },
  }[action]);

  try {
    return await syncIssue(gh, plan, {
      org,
      repo: SUMMARY_REPO,
      title,
      body,
      wanted: body != null,
      closeComment,
      label: `${SUMMARY_REPO} (OSPO summary)`,
      describe,
    });
  } catch (err) {
    if (isNotFound(err)) {
      throw new ScriptError(
        `repository ${where} not found. The OSPO summary issue cannot be managed without this repository.`,
      );
    }
    throw err;
  }
}
