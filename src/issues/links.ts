/**
 * Issue links from the task tree. The register has no parent field: a whole is planned after its parts (`update T9
 * --after T10,T11`), so each `after` edge between two tasks whose refs are issues of one repository becomes links on
 * the host. Every edge makes the whole blocked by the part; a part with one whole also becomes its sub-issue, since
 * an issue has one parent at most. A started task cannot take an `after` edge, so it waits on a task instead
 * (`set --waits task:T10`): that wait makes it blocked by the other task's issue too, but never its parent, since a
 * task waited on is a blocker, not a part. Links are only ever added: one a person set on the host stays.
 */

import type { Task } from '../register/fold.ts';
import { ISSUE_REF_PREFIX } from '../register/model.ts';
import { parseIssueTarget, type IssueTarget } from './host.ts';
import type { LinkedIssue } from './issue.ts';

/** One link to add: a sub-issue under its parent, or a blocker on the issue it blocks. */
export type LinkWrite =
  | { readonly kind: 'sub-issue'; readonly parent: IssueTarget; readonly child: IssueTarget; readonly childId: number }
  | { readonly kind: 'blocked-by'; readonly target: IssueTarget; readonly blocker: IssueTarget; readonly blockerId: number };

/** The links to add on one repository, and how many of the tree's links were left, by why. */
export interface LinkPlan {
  readonly writes: readonly LinkWrite[];
  /** Links the host already has. */
  readonly present: number;
  /** Parts under another parent on the host, so only their blocked-by links are added. */
  readonly otherParent: number;
  /** Parts that more than one whole is planned after: they get no parent, only blocked-by links. */
  readonly manyWholes: number;
  /** Edges whose other task's issue is in another repository: GitHub links them by hand only. */
  readonly otherRepo: number;
  /** Edges whose issue the host's read did not have (deleted or moved). */
  readonly missing: number;
}

/** The issue a task's ref names, or undefined when it names none. */
export function refTarget(task: Pick<Task, 'ref'>): IssueTarget | undefined {
  return task.ref !== null && task.ref.startsWith(ISSUE_REF_PREFIX) ? parseIssueTarget(task.ref.slice(ISSUE_REF_PREFIX.length)) : undefined;
}

/**
 * One edge between two tasks of the repository: the whole is planned after the part (`after`, which also asks for
 * the sub-issue), or waits on it (a task wait, which asks for the blocker only).
 */
interface Edge {
  readonly whole: IssueTarget;
  readonly part: IssueTarget;
  readonly sub: boolean;
}

/** The ids `task` is planned after, each asking for a sub-issue, then those it waits on and is not planned after. */
function partsOf(task: Task): readonly { readonly id: string; readonly sub: boolean }[] {
  const waited = task.waits.flatMap((reason) => (reason.kind === 'task' && !task.after.includes(reason.id) ? [reason.id] : []));
  return [...task.after.map((id) => ({ id, sub: true })), ...[...new Set(waited)].map((id) => ({ id, sub: false }))];
}

/**
 * The links the tasks' `after` edges and task waits ask for on `repo` (`owner/name`, lowercase) that `issues`, the
 * host's read of it, does not have yet. A dropped task makes no link: its plan no longer holds.
 */
export function planLinks(tasks: ReadonlyMap<string, Task>, repo: string, issues: readonly LinkedIssue[]): LinkPlan {
  const edges: Edge[] = [];
  let otherRepo = 0;
  for (const whole of tasks.values()) {
    const wholeTarget = refTarget(whole);
    if (whole.status === 'dropped' || wholeTarget?.repo !== repo) {
      continue;
    }
    for (const { id, sub } of partsOf(whole)) {
      const part = tasks.get(id);
      const partTarget = part === undefined || part.status === 'dropped' ? undefined : refTarget(part);
      if (partTarget === undefined) {
        continue;
      }
      if (partTarget.repo === repo) {
        edges.push({ whole: wholeTarget, part: partTarget, sub });
      } else {
        otherRepo += 1;
      }
    }
  }
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const wholesOf = new Map<number, number>();
  for (const edge of edges.filter((each) => each.sub)) {
    wholesOf.set(edge.part.number, (wholesOf.get(edge.part.number) ?? 0) + 1);
  }
  const writes: LinkWrite[] = [];
  let present = 0;
  let otherParent = 0;
  let manyWholes = 0;
  let missing = 0;
  for (const edge of edges) {
    const whole = byNumber.get(edge.whole.number);
    const part = byNumber.get(edge.part.number);
    if (whole === undefined || part === undefined) {
      missing += 1;
      continue;
    }
    if (whole.blockedBy.includes(part.number)) {
      present += 1;
    } else {
      writes.push({ kind: 'blocked-by', target: edge.whole, blocker: edge.part, blockerId: part.hostId });
    }
    if (!edge.sub) {
      continue;
    }
    if ((wholesOf.get(part.number) ?? 0) > 1) {
      manyWholes += 1;
    } else if (part.parent?.repo === repo && part.parent.number === whole.number) {
      present += 1;
    } else if (part.parent !== undefined) {
      otherParent += 1;
    } else {
      writes.push({ kind: 'sub-issue', parent: edge.whole, child: edge.part, childId: part.hostId });
    }
  }
  return { writes, present, otherParent, manyWholes, otherRepo, missing };
}

/** The issues a plan writes on: a sub-issue's parent, a blocker's blocked issue. */
export function changedIssues(plan: Pick<LinkPlan, 'writes'>): number {
  return new Set(plan.writes.map((write) => (write.kind === 'sub-issue' ? write.parent.number : write.target.number))).size;
}
