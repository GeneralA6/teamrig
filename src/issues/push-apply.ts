import { targetText, type IssueHost } from './host.ts';
import { changeLine, changeWrites, STATUS_LABEL_SPECS, type IssueChange, type PushPlan } from './status-push.ts';
import type { LabelSpec } from './host.ts';

/** What sending one repository's push did: the changes sent whole, their writes, and why it stopped, if it did. */
export interface PushOutcome {
  readonly sent: number;
  readonly writes: number;
  /** Changes held back because a label they add is not the repository's yet. */
  readonly held: number;
  /** Set when a write or a label read failed: the run sends nothing more to the repository. */
  readonly failed: string | undefined;
}

/**
 * Sends `plan`'s changes through `host`, one line said for each: MADE for a status label the repository lacked, made
 * once every read passed and before any change (a new repository has none, and its changes would wait for a person to
 * make them), MISSING for another label it lacks (its changes are held, as adding it would make a label the push does
 * not own), UNASSIGNED for a
 * login the repository may not assign (its changes go without the assign, as GitHub would drop it silently and the
 * next run would send it again), FAILED with the reason. Each label the plan adds, and each login it assigns, is read
 * once before any write; a login goes out as the host spells it, since GitHub drops an assign whose case is not the
 * login's own. A made label counts as a write, on top of the plan's: at most four, once for a repository. The first
 * failed write or read stops the
 * repository: the plan is drawn again from the issues as they are on the next run, so nothing is kept to resend and
 * a half-sent change is finished then.
 */
export async function applyPush(host: IssueHost, plan: PushPlan, say: (line: string) => void): Promise<PushOutcome> {
  const missing = new Set<string>();
  const toMake: LabelSpec[] = [];
  for (const label of new Set(plan.changes.flatMap((change) => change.add))) {
    const found = await host.labelExists(plan.repo, label);
    if (found.kind === 'failed') {
      say(`FAILED ${plan.repo}: ${found.reason}; nothing was written`);
      return { sent: 0, writes: 0, held: 0, failed: found.reason };
    }
    const own = STATUS_LABEL_SPECS.find((spec) => spec.name === label);
    if (found.kind === 'missing' && own !== undefined) {
      toMake.push(own);
    } else if (found.kind === 'missing') {
      missing.add(label);
    }
  }
  const unassignable = new Set<string>();
  const spelled = new Map<string, string>();
  for (const login of new Set(plan.changes.flatMap((change) => (change.assign === undefined ? [] : [change.assign])))) {
    const found = await host.assigneeExists(plan.repo, login);
    if (found.kind === 'failed') {
      say(`FAILED ${plan.repo}: ${found.reason}; nothing was written`);
      return { sent: 0, writes: 0, held: 0, failed: found.reason };
    }
    if (found.kind === 'missing') {
      unassignable.add(login);
    } else {
      spelled.set(login, found.login);
    }
  }
  let writes = 0;
  for (const label of toMake) {
    const made = await host.createLabel(plan.repo, label);
    if (made.kind === 'failed') {
      say(`FAILED ${plan.repo}: ${made.reason}; no change was sent`);
      return { sent: 0, writes, held: 0, failed: made.reason };
    }
    say(`MADE ${plan.repo}: the label ${JSON.stringify(label.name)}, which the push sets`);
    writes += 1;
  }
  for (const login of unassignable) {
    const left = plan.changes.filter((change) => change.assign === login).length;
    say(`UNASSIGNED ${plan.repo}: ${login} may not be assigned there (not a person with access to it); its ${left} issue(s) stay unassigned: map the owning session to a login that may under github.owners`);
  }
  const sendable = plan.changes.map((change) => assignedAs(change, unassignable, spelled)).filter((change) => changeWrites(change) > 0);
  const held = sendable.filter((change) => change.add.some((label) => missing.has(label)));
  for (const label of missing) {
    const waiting = held.filter((change) => change.add.includes(label)).length;
    say(`MISSING ${plan.repo}: no label ${JSON.stringify(label)}; make it there, and the ${waiting} change(s) adding it go on the next run`);
  }
  let sent = 0;
  for (const change of sendable.filter((one) => !held.includes(one))) {
    const failed = await sendChange(host, change);
    if (failed !== undefined) {
      say(`FAILED ${targetText(change.target)} ${change.task}: ${failed}; the rest of ${plan.repo} waits for the next run`);
      return { sent, writes, held: held.length, failed };
    }
    say(changeLine(change).replace(/^(LABEL|CLOSE|ASSIGN)/u, 'SET'));
    sent += 1;
    writes += changeWrites(change);
  }
  return { sent, writes, held: held.length, failed: undefined };
}

/** `change` with its assign as the host spells the login, or with none for a login the repository may not assign. */
function assignedAs(change: IssueChange, unassignable: ReadonlySet<string>, spelled: ReadonlyMap<string, string>): IssueChange {
  if (change.assign === undefined) {
    return change;
  }
  return unassignable.has(change.assign) ? withoutAssign(change) : { ...change, assign: spelled.get(change.assign) ?? change.assign };
}

/** `change` with no assign, for a login the repository may not assign. */
function withoutAssign(change: IssueChange): IssueChange {
  return { target: change.target, task: change.task, status: change.status, add: change.add, remove: change.remove, close: change.close };
}

/** Sends one change: its labels added, then each taken off, then the assign, then the close; the reason of the first failure, if any. */
async function sendChange(host: IssueHost, change: IssueChange): Promise<string | undefined> {
  if (change.add.length > 0) {
    const added = await host.addLabels(change.target, change.add);
    if (added.kind === 'failed') {
      return added.reason;
    }
  }
  for (const label of change.remove) {
    const removed = await host.removeLabel(change.target, label);
    if (removed.kind === 'failed') {
      return removed.reason;
    }
  }
  if (change.assign !== undefined) {
    const assigned = await host.assign(change.target, [change.assign]);
    if (assigned.kind === 'failed') {
      return assigned.reason;
    }
  }
  if (change.close !== undefined) {
    const closed = await host.close(change.target, change.close);
    if (closed.kind === 'failed') {
      return closed.reason;
    }
  }
  return undefined;
}
