import type { Task } from '../register/fold.ts';
import { DESIGN_LABEL } from './design-label.ts';
import { targetText, type Assignees, type Comments, type HostAccess, type IssueStore, type IssueTarget, type Labels } from './host.ts';
import type { IssueThread } from './issue.ts';
import { applyPush } from './push-apply.ts';
import { planAssigned, viewerOf } from './push-assignees.ts';
import { issuePushPlan, planIssue, pushAssignees, STATUS_LABEL_PREFIX, VIEWER_UNREAD, type SessionLogins } from './status-push.ts';

/**
 * A maintainer's reply on one issue (T3169): the words, and the state they speak of, sent together so the thread
 * never says more than it shows. The issue's status comes from the task holding it (the status push's own plan), so
 * the register is set first; `pull` is a pull request of the same repository that answers it, `followup` a new issue
 * for the part left over, `assign` logins to add.
 */
export interface ReplyWrite {
  readonly target: IssueTarget;
  readonly body: string;
  readonly pull?: number;
  readonly followup?: FollowUp;
  readonly assign: readonly string[];
}

/** An issue to open for the part of a thread the reply leaves to its own work. */
export interface FollowUp {
  readonly title: string;
  readonly body: string;
}

/**
 * What the reads before any write found: the thread replied on (`issue`, an issue or a labelled pull request), the
 * answering pull request, each as it is now, and each login as the host spells it.
 */
export interface ReplyReads {
  readonly issue: IssueThread;
  readonly pull: IssueThread | undefined;
  readonly logins: readonly string[];
}

/** How the reads ended: read, or refused with the reason, nothing written. */
export type ReplyCheck = { readonly kind: 'read'; readonly reads: ReplyReads } | { readonly kind: 'refused'; readonly reason: string };

/**
 * Reads, writing nothing, what the reply needs: the host reached, the issue (an issue, not a pull request), the pull
 * request (open and one), and each login to assign (one the repository may assign). Run before the register is set,
 * so a reply that cannot be sent changes nothing anywhere.
 */
export async function checkReply(host: HostAccess & IssueStore & Assignees, write: ReplyWrite, say: (line: string) => void): Promise<ReplyCheck> {
  const { target } = write;
  const reach = await host.reach(target.repo, 'write');
  if (reach.kind === 'unreachable') {
    return { kind: 'refused', reason: reach.reason };
  }
  say(`ACCESS ${reach.access}`);
  const issue = await threadOf(host, target, undefined);
  if (issue.kind === 'refused') {
    return issue;
  }
  // A pull request carries no status of its own (its issue does), but it is never left bare: labels before words.
  if (issue.thread.pull && write.pull !== undefined) {
    return { kind: 'refused', reason: `${targetText(target)} is a pull request: --pr names the pull request that answers an issue, so reply on that issue` };
  }
  if (issue.thread.pull && issue.thread.labels.length === 0) {
    return { kind: 'refused', reason: `${targetText(target)} has no labels: label it first (teamrig issue label ${targetText(target)} --add <type,area>)` };
  }
  let pull: IssueThread | undefined;
  if (write.pull !== undefined) {
    const read = await threadOf(host, { repo: target.repo, number: write.pull }, true);
    if (read.kind === 'refused') {
      return read;
    }
    if (read.thread.state !== 'open') {
      return { kind: 'refused', reason: `${targetText({ repo: target.repo, number: write.pull })} is closed: name the open pull request that answers ${targetText(target)}` };
    }
    pull = read.thread;
  }
  const logins: string[] = [];
  for (const login of write.assign) {
    const found = await host.assigneeExists(target.repo, login);
    if (found.kind === 'failed') {
      return { kind: 'refused', reason: found.reason };
    }
    if (found.kind === 'missing') {
      return { kind: 'refused', reason: `${login} may not be assigned in ${target.repo} (not a person with access to it)` };
    }
    logins.push(found.login);
  }
  return { kind: 'read', reads: { issue: issue.thread, pull, logins } };
}

/** One read of `target`, refused when the host has none or it is not of the kind `pull` names (either, when undefined). */
async function threadOf(host: IssueStore, target: IssueTarget, pull: boolean | undefined): Promise<{ readonly kind: 'read'; readonly thread: IssueThread } | { readonly kind: 'refused'; readonly reason: string }> {
  const shown = targetText(target);
  const read = await host.thread(target);
  if (read.kind === 'failed') {
    return { kind: 'refused', reason: read.reason };
  }
  if (read.kind === 'missing') {
    return { kind: 'refused', reason: `${shown} is no issue or pull request the access can see` };
  }
  if (pull === true && !read.thread.pull) {
    return { kind: 'refused', reason: `${shown} is an issue, not a pull request: --pr names the pull request that answers it` };
  }
  return read;
}

/**
 * Sends the reply, the comment last: the issue's status from `task` (the push's plan, applyPush's lines), the
 * assignees, the pull request's link (a closing line added to its body when it has none) and the issue's labels on
 * it, the follow-up issue, then the comment, which names the follow-up. The first failure stops it, saying what was
 * done, and the comment is not posted: a thread may show its state before its words, never words ahead of its state.
 * `task` is the one holding an issue; a pull request has none, its labels checked by checkReply. True when every step
 * was done.
 */
export async function sendReply(host: IssueStore & Comments & Labels & Assignees, write: ReplyWrite, reads: ReplyReads, task: Task | undefined, logins: SessionLogins, say: (line: string) => void): Promise<boolean> {
  const { target } = write;
  const shown = targetText(target);
  const done: string[] = [];
  const failed = (reason: string): false => {
    say(`FAILED ${shown}: ${reason}${done.length === 0 ? '' : `; it already ${done.join(', ')}`}; the comment was not posted`);
    return false;
  };
  if (task !== undefined) {
    if (planIssue(target, task, reads.issue).kind === 'closed-active') {
      return failed(`${shown} is closed while ${task.id} is ${task.status}: reopen it, or end the task, before replying`);
    }
    // Assigned as the repository push assigns (T4581): a login the repository may not take is passed over. The status
    // label is planned under the tracker's name for it, as the repository push plans it.
    const planned = await planAssigned(host, target.repo, (who) => issuePushPlan(target, task, reads.issue, who, (label) => host.labelName(label)), pushAssignees(logins, VIEWER_UNREAD), () => viewerOf(host, target.repo, say), say);
    if (planned.kind === 'failed') {
      return failed(planned.reason);
    }
    if (planned.plan.changes.length > 0) {
      const pushed = await applyPush(host, planned.plan, say);
      // A held change adds a label the repository lacks; the status labels are made, so only a person's edit gets here.
      if (pushed.failed !== undefined || pushed.held > 0) {
        return failed(pushed.failed ?? `its status label is missing from ${target.repo}`);
      }
      done.push(`shows ${task.status}`);
    }
  }
  const toAssign = reads.logins.filter((login) => !reads.issue.assignees.some((now) => now.toLowerCase() === login.toLowerCase()));
  if (toAssign.length > 0) {
    const assigned = await host.assign(target, toAssign);
    if (assigned.kind === 'failed') {
      return failed(assigned.reason);
    }
    say(`ASSIGNED ${shown}: ${toAssign.join(', ')}`);
    done.push(`assigned ${toAssign.join(', ')}`);
  }
  if (write.pull !== undefined && reads.pull !== undefined) {
    const linked = await linkPull(host, target, { repo: target.repo, number: write.pull }, reads, say);
    if (linked.kind === 'failed') {
      return failed(linked.reason);
    }
    done.push(...linked.done);
  }
  let comment = write.body;
  if (write.followup !== undefined) {
    const opened = await host.open({ repo: target.repo, title: write.followup.title, body: `${write.followup.body}\n\nSplit from #${target.number}.`.trim(), labels: [] });
    if (opened.kind === 'failed') {
      return failed(opened.reason);
    }
    say(`OPENED ${targetText(opened.target)}: the follow-up of ${shown}`);
    done.push(`opened the follow-up #${opened.target.number}`);
    comment = `${comment.trimEnd()}\n\nFollow-up: #${opened.target.number}`;
  }
  const commented = await host.comment(target, comment);
  if (commented.kind === 'failed') {
    return failed(commented.reason);
  }
  say(`COMMENTED ${shown}`);
  return true;
}

/** What linking the pull request did: done with each step taken, or failed with the reason. */
type PullLink = { readonly kind: 'done'; readonly done: readonly string[] } | { readonly kind: 'failed'; readonly reason: string };

/**
 * Links `pull` to the issue: a closing line added to its body when no line there closes the issue (the host links a
 * pull request to the issues its body closes), and the issue's own labels it lacks added, but for the status and
 * design labels, which are the issue's alone.
 */
async function linkPull(host: IssueStore & Labels, target: IssueTarget, pull: IssueTarget, reads: ReplyReads, say: (line: string) => void): Promise<PullLink> {
  const shown = targetText(pull);
  const pullThread = reads.pull;
  if (pullThread === undefined) {
    return { kind: 'done', done: [] };
  }
  const done: string[] = [];
  if (!closesIssue(pullThread.body, target)) {
    const body = `${pullThread.body.trimEnd()}\n\nCloses #${target.number}`.trimStart();
    const edited = await host.editBody(pull, body);
    if (edited.kind === 'failed') {
      return { kind: 'failed', reason: edited.reason };
    }
    say(`LINKED ${shown}: its body now closes #${target.number}`);
    done.push(`linked ${shown}`);
  }
  const labels = reads.issue.labels.filter((label) => !label.startsWith(STATUS_LABEL_PREFIX) && label !== DESIGN_LABEL && !pullThread.labels.includes(label));
  if (labels.length > 0) {
    const added = await host.addLabels(pull, labels);
    if (added.kind === 'failed') {
      return { kind: 'failed', reason: added.reason };
    }
    say(`LABELED ${shown}: ${labels.map((label) => JSON.stringify(label)).join(', ')}`);
    done.push(`labelled ${shown}`);
  }
  return { kind: 'done', done };
}

/**
 * Whether `body` closes `target` the way GitHub reads a closing keyword: close, fix or resolve in any of their forms,
 * an optional colon, then `#n` or `owner/name#n` (a URL to the issue too), the number whole.
 */
export function closesIssue(body: string, target: IssueTarget): boolean {
  const repo = target.repo.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
  const named = `(?:#|${repo}#|https://github\\.com/${repo}/issues/)${target.number}(?![0-9])`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?\\s+${named}`, 'iu').test(body);
}
