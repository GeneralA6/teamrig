import type { KitConfig } from '../../config/types.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { formatClocks, issueThread, parseClocks, reminderText, stepClocks, type Clock, type Thread } from '../../github/clock.ts';
import { issueOwner, issueRef, type ImportRules } from '../../github/map.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { HostIssue } from '../../issues/issue.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import type { Task } from '../../register/fold.ts';
import { fileLockOf } from '../file-locks.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * The response clock's part of a sync that writes (T3028, github/clock.ts): from each repository it read, the open
 * threads and who answers each, then the clocks kept in their own file under the sync's lock, and one unwoken inbox
 * line to each owner whose thread reached 75% of its answer target. GH-LATE at 100% is `check`'s (issue-clock-check.ts).
 */

/** The open issues of one repository read as threads: one a task tracks is held and answered by that task's owner, any other by the import's owner rule. */
export function repoThreads(issues: readonly HostIssue[], tasks: readonly Task[], rules: ImportRules): Thread[] {
  const holders = new Map<string, string>();
  for (const task of tasks) {
    if (task.ref !== null && !holders.has(task.ref)) {
      holders.set(task.ref, task.owner);
    }
  }
  return issues.flatMap((issue) => {
    const ref = issueRef(issue.repo, issue.number);
    const holder = holders.get(ref);
    return issueThread(issue, ref, holder ?? issueOwner(issue, rules), holder !== undefined) ?? [];
  });
}

/**
 * Steps the clocks over the repositories in `read` and posts each reminder due now, unwoken. Gives one line per
 * reminder posted and per one the inbox refused.
 */
export async function recordClocks(runtime: CliRuntime, kit: Kit, config: KitConfig, read: ReadonlySet<string>, threads: readonly Thread[]): Promise<string[]> {
  const now = runtime.clock.now();
  const remind = await fileLockOf(runtime, kit.paths.githubSyncLock, config.lock).run(async (): Promise<readonly Clock[]> => {
    const step = stepClocks(parseClocks((await runtime.files.read(kit.paths.githubClocks)) ?? ''), read, threads, now);
    await runtime.files.write(kit.paths.githubClocks, formatClocks(step.clocks));
    return step.remind;
  });
  const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
  const secrets = new SecretScanner(config.register.secretPatterns);
  const zone = teamZone(config, runtime);
  const lines: string[] = [];
  for (const clock of remind) {
    const problem = await postLine(inboxes, secrets, { to: clock.owner, from: GITHUB_ACTOR, text: reminderText(clock, now, zone), now: new Date(now) });
    lines.push(problem === undefined ? `REMINDED ${clock.owner}: ${clock.ref} waits on an answer` : `INBOX ${clock.owner}: not posted: ${problem}`);
  }
  return lines;
}
