import type { KitConfig } from '../../config/types.ts';
import { ENV, type Env } from '../../core/home.ts';
import { writableObject } from '../../core/jsonl.ts';
import type { FileLock } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import {
  addedLines,
  failureNews,
  finishState,
  formatSyncState,
  leftOutNews,
  parseSyncState,
  SYNC_STATE_FORMAT,
  type SyncRun,
  type SyncState,
} from '../../github/auto.ts';
import { issueRef } from '../../github/map.ts';
import { pullNewsText } from '../../github/pull-news.ts';
import { ourLogins } from '../../github/trust.ts';
import { securityLine, securityPageText, unpagedIssues, unpagedLine, type SecurityIssue } from '../../github/security-alert.ts';
import { errorMessage } from '../../core/guards.ts';
import { sendOwnerPage } from '../login-page.ts';
import { postLine } from '../../inbox/inbox.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { postUrgentLine } from '../urgent-line.ts';
import { inboxDepsOf } from './inbox.ts';
import { fileLockOf } from '../file-locks.ts';

/**
 * The automatic GitHub sync's report: `issue watch` (issue-watch.ts) runs `issue sync --auto` when GitHub changed,
 * and that run tells each owner's inbox the tasks it added, the lead's when the failing repositories change or an
 * outsider's issue is newly left out, and each session the pull request news of its share (pull-news.ts).
 */

/** `TEAMRIG_GITHUB=off` turns the import off on this machine, whatever the team config says. */
export const GITHUB_OFF = 'off';

export function githubOff(env: Env): boolean {
  return env[ENV.github]?.trim().toLowerCase() === GITHUB_OFF;
}

/** The lock around the sync state file, held while a finishing sync records its end. */
function stateLock(runtime: CliRuntime, kit: Kit, config: KitConfig, waitMs: number): FileLock {
  return fileLockOf(runtime, kit.paths.githubSyncLock, { ...config.lock, waitMs });
}

/** The last sync's state, read without the lock: what a sync compares its pull request reads with. */
export async function readSyncState(runtime: CliRuntime, kit: Kit): Promise<SyncState | undefined> {
  return parseSyncState((await runtime.files.read(kit.paths.githubSync)) ?? '');
}

/**
 * The state before a write, under the lock. A file a newer teamrig wrote is refused (`NewerDataError`), so an older
 * teamrig still running in some tab never drops its fields: its hook starts no sync, its `issue sync --auto` fails.
 */
async function writableState(runtime: CliRuntime, kit: Kit): Promise<SyncState | undefined> {
  const text = await runtime.files.read(kit.paths.githubSync);
  writableObject(kit.paths.githubSync, text, SYNC_STATE_FORMAT);
  return parseSyncState(text ?? '');
}

/**
 * What `issue sync --auto` does once it has written: records its finish, failing repositories and left-out issues,
 * then posts one inbox line to each owner naming the tasks added for it, one to the lead when the failing
 * repositories changed (`failureNews`) and one when an outsider's issue was left out that was not before
 * (`leftOutNews`), and one to each session with pull request news (`pullNewsText`), which also wakes it when
 * the news needs a hand soon and the team has wake on. It gives a line for each inbox line that was refused, such as
 * an issue title that matches a secret pattern.
 */
export async function reportAutoSync(runtime: CliRuntime, kit: Kit, config: KitConfig, run: SyncRun): Promise<string[]> {
  const now = runtime.clock.now();
  const { before, after } = await stateLock(runtime, kit, config, config.lock.waitMs).run(async () => {
    const state = await writableState(runtime, kit);
    const finished = finishState(state, now, run);
    await runtime.files.write(kit.paths.githubSync, formatSyncState(finished));
    return { before: state, after: finished };
  });
  const posts = [...addedLines(run.added)].map(([to, text]) => ({ to, text, wake: false }));
  const news = [failureNews(before?.failing ?? [], run.failures), leftOutNews(before?.leftOut ?? new Map(), after.leftOut, config.github.acceptLabel)];
  for (const text of news) {
    if (text !== undefined) {
      posts.push({ to: config.roles.lead, text, wake: false });
    }
  }
  const ours = ourLogins(config.github);
  for (const [to, events] of run.pullNews) {
    posts.push({ to, ...pullNewsText(events, ours) });
  }
  const lines: string[] = [];
  // Each open security issue not paged before wakes its session and pages the owner; the state now holds it as paged,
  // so a page that failed is told to the lead once rather than retried at every run.
  for (const issue of unpagedIssues(run.security, before?.paged ?? new Map())) {
    posts.push({ to: issue.to, text: securityLine(issue), wake: true });
    const page = await securityPage(runtime, kit.paths.team, issue);
    lines.push(page.line);
    if (page.why !== undefined) {
      posts.push({ to: config.roles.lead, text: unpagedLine(issue, page.why), wake: true });
    }
  }
  const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
  const secrets = new SecretScanner(config.register.secretPatterns);
  const refused: string[] = lines;
  for (const { to, text, wake } of posts) {
    const problem =
      wake && config.wake.enabled
        ? await postUrgentLine(runtime, kit, config, { to, from: GITHUB_ACTOR, text })
        : await postLine(inboxes, secrets, { to, from: GITHUB_ACTOR, text, now: new Date(now) });
    if (problem !== undefined) {
      refused.push(`INBOX ${to}: not posted: ${problem}`);
    }
  }
  return refused;
}

/** Pages the owner for a security issue: the run's line, and why no page went (undefined once one did). */
async function securityPage(runtime: CliRuntime, team: string, issue: SecurityIssue): Promise<{ readonly line: string; readonly why: string | undefined }> {
  const ref = issueRef(issue.repo, issue.number);
  try {
    const sent = await sendOwnerPage(runtime, team, (zone) => securityPageText(issue, team, zone.clock(new Date(runtime.clock.now()))));
    if (sent.status === 'ok') {
      return { line: `PAGED the owner for security issue ${ref} through ${sent.source.team}'s alerts.${sent.source.key}`, why: undefined };
    }
    const why =
      sent.status === 'none'
        ? `no team from ${team} up names alerts.pageWebhookFile or alerts.pageWebhookEnv`
        : `${sent.source.team}'s alerts.${sent.source.key}: ${sent.problem}`;
    return { line: `NO PAGE for security issue ${ref}: ${why}`, why };
  } catch (error) {
    const why = `the page failed: ${errorMessage(error)}`;
    return { line: `NO PAGE for security issue ${ref}: ${why}`, why };
  }
}
