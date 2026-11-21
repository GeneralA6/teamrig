import type { KitConfig } from '../../config/types.ts';
import { writableObject } from '../../core/jsonl.ts';
import { SecretScanner } from '../../core/secrets.ts';
import {
  CLOCK_STATE_FORMAT,
  formatClocks,
  issueThread,
  ownerFirstOf,
  parseClocks,
  pullThread,
  remindersText,
  stepClocks,
  toldsText,
  type Clock,
  type ClockStep,
  type OwnerFirst,
  type Thread,
} from '../../github/clock.ts';
import { issueOwner, issueRef, type ImportRules } from '../../github/map.ts';
import type { OurLogins } from '../../github/trust.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { HostIssue } from '../../issues/issue.ts';
import type { HostPull } from '../../issues/pull.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import type { Task } from '../../register/fold.ts';
import { fileLockOf } from '../file-locks.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * The response clock's part of a sync that writes (T3028, github/clock.ts): from each repository it read, the open
 * threads (issues and pull requests) and who answers each, then the clocks kept in their own file under the sync's lock, and one unwoken inbox
 * line to each owner whose thread reached 75% of its answer target, and one GH-LATE line at 100% to an owner told
 * before the lead. The lead's GH-LATE is `check`'s (src/cli/github-late-check.ts).
 */

/**
 * The open issues of one repository read as threads: one a task tracks is held and answered by that task's owner, any
 * other by the import's owner rule. A post is ours by `ours`, the team's logins (github/clock.ts postIsOurs).
 */
export function repoThreads(issues: readonly HostIssue[], tasks: readonly Task[], rules: ImportRules, ours: OurLogins): Thread[] {
  const holders = new Map<string, string>();
  for (const task of tasks) {
    if (task.ref !== null && !holders.has(task.ref)) {
      holders.set(task.ref, task.owner);
    }
  }
  return issues.flatMap((issue) => {
    const ref = issueRef(issue.repo, issue.number);
    const holder = holders.get(ref);
    return issueThread(issue, ref, holder ?? issueOwner(issue, rules), holder !== undefined, ours) ?? [];
  });
}

/**
 * The open pull requests of one repository read as `pull` threads, each once, answered by whom its news goes to: the
 * owner of the task one of our own branches names, else `watcher` (github/pull-news.ts pullRecipient). Give it the
 * open read's pull requests: only that read carries their posts (github/queries.ts).
 */
export function pullThreads(pulls: readonly HostPull[], recipientOf: (pull: HostPull) => string, ours: OurLogins): Thread[] {
  const seen = new Set<string>();
  return pulls.flatMap((pull) => {
    const ref = issueRef(pull.repo, pull.number);
    if (seen.has(ref)) {
      return [];
    }
    seen.add(ref);
    return pullThread(pull, ref, recipientOf(pull), ours) ?? [];
  });
}

/** Whose threads' owners are told GH-LATE before the lead: the team's sessions but the lead (github/clock.ts). */
export function teamOwnerFirst(config: KitConfig): OwnerFirst {
  return ownerFirstOf(config.sessions, config.roles.lead);
}

/**
 * Steps the clocks over the repositories in `read` and posts the reminders and the owners' GH-LATE lines due now,
 * unwoken: one line of each per owner, naming its count and first few when several fall due at once (#1475). Gives
 * one line per owner reminded or told and per one the inbox refused. A clocks file a newer teamrig wrote is refused
 * before the write (`NewerDataError`), so its fields are never dropped.
 */
export async function recordClocks(runtime: CliRuntime, kit: Kit, config: KitConfig, read: ReadonlySet<string>, threads: readonly Thread[]): Promise<string[]> {
  const now = runtime.clock.now();
  const ownerFirst = teamOwnerFirst(config);
  const step = await fileLockOf(runtime, kit.paths.githubSyncLock, config.lock).run(async (): Promise<ClockStep> => {
    const text = await runtime.files.read(kit.paths.githubClocks);
    writableObject(kit.paths.githubClocks, text, CLOCK_STATE_FORMAT);
    const next = stepClocks(parseClocks(text ?? ''), read, threads, now, ownerFirst);
    await runtime.files.write(kit.paths.githubClocks, formatClocks(next.clocks));
    return next;
  });
  const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
  const secrets = new SecretScanner(config.register.secretPatterns);
  const zone = teamZone(config, runtime);
  const lines: string[] = [];
  for (const [owner, clocks] of byOwner(step.remind)) {
    const problem = await postLine(inboxes, secrets, { to: owner, from: GITHUB_ACTOR, text: remindersText(clocks, now, zone, ownerFirst), now: new Date(now) });
    const what = clocks.length === 1 ? `${clocks[0]?.ref} waits` : `${clocks.length} GitHub threads wait`;
    lines.push(problem === undefined ? `REMINDED ${owner}: ${what} on an answer` : `INBOX ${owner}: not posted: ${problem}`);
  }
  for (const [owner, clocks] of byOwner(step.tell)) {
    const problem = await postLine(inboxes, secrets, { to: owner, from: GITHUB_ACTOR, text: toldsText(clocks, now, zone, ownerFirst), now: new Date(now) });
    const what = clocks.length === 1 ? `${clocks[0]?.ref} is past its` : `${clocks.length} GitHub threads are past their`;
    lines.push(problem === undefined ? `TOLD ${owner}: ${what} answer target` : `INBOX ${owner}: not posted: ${problem}`);
  }
  return lines;
}

/** Clocks by their owner, in the order each owner first comes. */
function byOwner(clocks: readonly Clock[]): Map<string, Clock[]> {
  const owners = new Map<string, Clock[]>();
  for (const clock of clocks) {
    owners.set(clock.owner, [...(owners.get(clock.owner) ?? []), clock]);
  }
  return owners;
}
