import type { Task } from '../register/fold.ts';
import { GITHUB_SOURCE, ISSUE_REF_PREFIX, type TaskStatus } from '../register/model.ts';
import { parseIssueTarget, targetText, type CloseReason, type IssueTarget } from './host.ts';
import type { HostIssue } from './issue.ts';

/**
 * The status push (T2682): each issue a task holds shows that task's status, so a reader of the issue list sees
 * where the work stands without a teamrig team. The register is the store of record: an active task gives its
 * issue one `status:` label, a done task closes it as completed, a dropped one as not planned. The plan compares
 * the task with the issue as the host lists it now, not with what an earlier run sent, so five status changes since
 * the last run are one label swap, a run that failed half way is redone by the next, and a status label someone
 * edited by hand is set back. A person's close is never undone here: the issue stays closed and the plan names it.
 */

/** The label namespace the push owns: any label in it but the task's own is taken off. */
export const STATUS_LABEL_PREFIX = 'status:';

/** The active statuses, each with the one label its issue shows. */
export const STATUS_LABELS: Readonly<Record<'open' | 'in-progress' | 'waiting' | 'verifying', string>> = {
  open: `${STATUS_LABEL_PREFIX}triaged`,
  'in-progress': `${STATUS_LABEL_PREFIX}in-progress`,
  waiting: `${STATUS_LABEL_PREFIX}waiting`,
  verifying: `${STATUS_LABEL_PREFIX}in-review`,
};

/**
 * The writes one run sends at most. GitHub's secondary limit on content-creating calls is 80 a minute; half of it
 * leaves room for the team's other writes (comments, the ship's pull requests) in the same minute. The rest of the
 * plan waits for the next run, which plans it again from the issues as they are then.
 */
export const PUSH_WRITES_PER_RUN = 40;

/** What an issue should show for its task: open with one status label, or closed for a reason. */
export type IssueGoal = { readonly open: true; readonly label: string } | { readonly open: false; readonly reason: CloseReason };

/** The issue a task's status calls for. */
export function issueGoal(status: TaskStatus): IssueGoal {
  switch (status) {
    case 'done':
      return { open: false, reason: 'completed' };
    case 'dropped':
      return { open: false, reason: 'not-planned' };
    default:
      return { open: true, label: STATUS_LABELS[status] };
  }
}

/** The writes that bring one issue in step with its task: the labels to add and take off, and a close. */
export interface IssueChange {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /** Set when the issue is to close, for this reason. */
  readonly close: CloseReason | undefined;
}

/** A closed issue whose task is still active: closed by a person, so it stays closed, and the task's owner decides. */
export interface ClosedActive {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
  /** Why it closed, as the host names it; empty when it gives none. */
  readonly stateReason: string;
}

/** An issue an active task holds that the host did not list as open or lately closed. */
export interface UnlistedIssue {
  readonly target: IssueTarget;
  readonly task: string;
  readonly status: TaskStatus;
}

/** What a push of one repository would send, and what it leaves. */
export interface PushPlan {
  readonly repo: string;
  /** The changes this run sends, whole, in issue order, within PUSH_WRITES_PER_RUN writes. */
  readonly changes: readonly IssueChange[];
  /** The changes left for the next run, past the run's writes. */
  readonly deferred: readonly IssueChange[];
  /** Issues already showing their task's status. */
  readonly unchanged: number;
  readonly closedActive: readonly ClosedActive[];
  /** Issues an active task holds that the list did not include: closed before the listed days, or gone. */
  readonly unlisted: readonly UnlistedIssue[];
}

/** The writes one change sends: one per label added or taken off, and one for the close. */
export function changeWrites(change: IssueChange): number {
  return change.add.length + change.remove.length + (change.close === undefined ? 0 : 1);
}

/**
 * The push of `repo`: for each issue of it a task holds, by `ref: gh:<repo>#<n>`, the writes that make the issue
 * show the task's status, planned against `issues` as the host listed them now (open ones and those closed lately).
 * When a team task and an imported one hold the same issue, the team task speaks for it: the issue is its work.
 */
export function planPush(repo: string, issues: readonly HostIssue[], tasks: Iterable<Task>): PushPlan {
  const listed = new Map(issues.filter((issue) => issue.repo === repo).map((issue) => [issue.number, issue]));
  const planned: IssueChange[] = [];
  const closedActive: ClosedActive[] = [];
  const unlisted: UnlistedIssue[] = [];
  let unchanged = 0;
  for (const [target, task] of [...holders(repo, tasks)].sort(([a], [b]) => a - b).map(([number, holder]) => [{ repo, number }, holder] as const)) {
    const issue = listed.get(target.number);
    const goal = issueGoal(task.status);
    if (issue === undefined) {
      // The list holds every open issue, so one it left out is closed (or gone): as a closed task wants it.
      if (goal.open) {
        unlisted.push({ target, task: task.id, status: task.status });
      } else {
        unchanged += 1;
      }
      continue;
    }
    if (issue.state === 'closed' && goal.open) {
      closedActive.push({ target, task: task.id, status: task.status, stateReason: issue.stateReason });
      continue;
    }
    const change = changeFor(target, task, issue, goal);
    if (change === undefined) {
      unchanged += 1;
    } else {
      planned.push(change);
    }
  }
  const { changes, deferred } = withinRun(planned);
  return { repo, changes, deferred, unchanged, closedActive, unlisted };
}

/** The task speaking for each issue number of `repo` a task holds: a team task over one the import added. */
function holders(repo: string, tasks: Iterable<Task>): Map<number, Task> {
  const byNumber = new Map<number, Task>();
  for (const task of tasks) {
    const target = heldIssue(task);
    if (target?.repo !== repo) {
      continue;
    }
    const held = byNumber.get(target.number);
    if (held === undefined || (held.source === GITHUB_SOURCE && task.source !== GITHUB_SOURCE)) {
      byNumber.set(target.number, task);
    }
  }
  return byNumber;
}

/** The issue a task holds by its `gh:` ref, or undefined when its ref names none. */
export function heldIssue(task: Task): IssueTarget | undefined {
  return task.ref?.startsWith(ISSUE_REF_PREFIX) === true ? parseIssueTarget(task.ref.slice(ISSUE_REF_PREFIX.length)) : undefined;
}

/**
 * The writes for one listed issue, or undefined when it already shows its task's status. A closing issue loses its
 * status labels too, so a closed issue never shows work as still going on.
 */
function changeFor(target: IssueTarget, task: Task, issue: HostIssue, goal: IssueGoal): IssueChange | undefined {
  const statusLabels = issue.labels.filter((label) => label.startsWith(STATUS_LABEL_PREFIX));
  if (!goal.open) {
    if (issue.state === 'closed') {
      return undefined;
    }
    return { target, task: task.id, status: task.status, add: [], remove: statusLabels, close: goal.reason };
  }
  const add = statusLabels.includes(goal.label) ? [] : [goal.label];
  const remove = statusLabels.filter((label) => label !== goal.label);
  return add.length === 0 && remove.length === 0 ? undefined : { target, task: task.id, status: task.status, add, remove, close: undefined };
}

/** The whole changes that fit in one run's writes, in order, and the rest. A change is never split across runs. */
function withinRun(planned: readonly IssueChange[]): { changes: IssueChange[]; deferred: IssueChange[] } {
  const changes: IssueChange[] = [];
  const deferred: IssueChange[] = [];
  let writes = 0;
  for (const change of planned) {
    const cost = changeWrites(change);
    if (deferred.length === 0 && writes + cost <= PUSH_WRITES_PER_RUN) {
      changes.push(change);
      writes += cost;
    } else {
      deferred.push(change);
    }
  }
  return { changes, deferred };
}

/** One change on one line: the issue, its task and status, then each write. */
export function changeLine(change: IssueChange): string {
  const writes = [
    ...(change.close === undefined ? [] : [`close as ${change.close}`]),
    ...change.add.map((label) => `add ${label}`),
    ...change.remove.map((label) => `take off ${label}`),
  ];
  return `${change.close === undefined ? 'LABEL' : 'CLOSE'} ${targetText(change.target)} ${change.task} ${change.status}: ${writes.join(', ')}`;
}
