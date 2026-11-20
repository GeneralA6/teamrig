import { targetText, type Assignees, type IssueStore, type Labels } from './host.ts';
import { specHeldAs } from './managed-labels.ts';
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
 * not own), FAILED with the reason. The plan names each label as the tracker holds it (planPush), so a status label
 * is known, and made, by that name. Each label the plan adds is read once before any write. Each login it assigns was
 * read when it was planned (push-assignees.ts planAssigned), so it goes out as it is. A made label counts as a write, on
 * top of the plan's: at most four, once for a repository. The first failed write or read stops the repository: the
 * plan is drawn again from the issues as they are on the next run, so nothing is kept to resend and a half-sent change
 * is finished then.
 */
export async function applyPush(host: Labels & Assignees & IssueStore, plan: PushPlan, say: (line: string) => void): Promise<PushOutcome> {
  const missing = new Set<string>();
  const toMake: LabelSpec[] = [];
  for (const label of new Set(plan.changes.flatMap((change) => change.add))) {
    const found = await host.labelExists(plan.repo, label);
    if (found.kind === 'failed') {
      say(`FAILED ${plan.repo}: ${found.reason}; nothing was written`);
      return { sent: 0, writes: 0, held: 0, failed: found.reason };
    }
    const own = specHeldAs(STATUS_LABEL_SPECS, label, (name) => host.labelName(name));
    if (found.kind === 'missing' && own !== undefined) {
      toMake.push(own);
    } else if (found.kind === 'missing') {
      missing.add(label);
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
  const held = plan.changes.filter((change) => change.add.some((label) => missing.has(label)));
  for (const label of missing) {
    const waiting = held.filter((change) => change.add.includes(label)).length;
    say(`MISSING ${plan.repo}: no label ${JSON.stringify(label)}; make it there, and the ${waiting} change(s) adding it go on the next run`);
  }
  let sent = 0;
  for (const change of plan.changes.filter((one) => !held.includes(one))) {
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

/** Sends one change: its labels added, then each taken off, then the assign, then the close; the reason of the first failure, if any. */
async function sendChange(host: Labels & Assignees & IssueStore, change: IssueChange): Promise<string | undefined> {
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
