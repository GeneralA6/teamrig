/**
 * Issue links from the task tree. The register has no parent field: a whole is planned after its parts (`update T9
 * --after T10,T11`), so each `after` edge between two tasks whose refs are issues of one repository becomes links on
 * the host. Every edge makes the whole blocked by the part; a part with one whole also becomes its sub-issue, since
 * an issue has one parent at most. A started task cannot take an `after` edge, so it waits on a task instead
 * (`set --waits task:T10`): that wait makes it blocked by the other task's issue too, but never its parent, since a
 * task waited on is a blocker, not a part. Links are only ever added: one a person set on the host stays. A link is
 * between two issues, not two tasks: two tasks can hold one issue, so the edges are kept once per issue pair, and an
 * edge between two tasks of one issue makes no link (T3352).
 */
import { ISSUE_REF_PREFIX } from "../register/model.js";
import { parseIssueTarget } from "./host.js";
/** The issue a task's ref names, or undefined when it names none. */
export function refTarget(task) {
    return task.ref !== null && task.ref.startsWith(ISSUE_REF_PREFIX) ? parseIssueTarget(task.ref.slice(ISSUE_REF_PREFIX.length)) : undefined;
}
/** The ids `task` is planned after, each asking for a sub-issue, then those it waits on and is not planned after. */
function partsOf(task) {
    const waited = task.waits.flatMap((reason) => (reason.kind === 'task' && !task.after.includes(reason.id) ? [reason.id] : []));
    return [...task.after.map((id) => ({ id, sub: true })), ...[...new Set(waited)].map((id) => ({ id, sub: false }))];
}
/**
 * The links the tasks' `after` edges and task waits ask for on `repo` (`owner/name`, lowercase) that `issues`, the
 * host's read of it, does not have yet. A dropped task makes no link: its plan no longer holds.
 */
export function planLinks(tasks, repo, issues) {
    const edges = new Map();
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
            if (partTarget.repo !== repo) {
                otherRepo += 1;
            }
            else if (partTarget.number !== wholeTarget.number) {
                // GitHub takes each link once: a second add of one pair fails the run with a 422, so a pair held twice is one edge,
                // a sub-issue when either of its task edges asks for one.
                const key = `${wholeTarget.number}>${partTarget.number}`;
                edges.set(key, { whole: wholeTarget, part: partTarget, sub: sub || (edges.get(key)?.sub ?? false) });
            }
        }
    }
    const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
    const wholesOf = new Map();
    for (const edge of [...edges.values()].filter((each) => each.sub)) {
        wholesOf.set(edge.part.number, (wholesOf.get(edge.part.number) ?? 0) + 1);
    }
    const writes = [];
    let present = 0;
    let otherParent = 0;
    let manyWholes = 0;
    let missing = 0;
    for (const edge of edges.values()) {
        const whole = byNumber.get(edge.whole.number);
        const part = byNumber.get(edge.part.number);
        if (whole === undefined || part === undefined) {
            missing += 1;
            continue;
        }
        if (whole.blockedBy.includes(part.number)) {
            present += 1;
        }
        else {
            writes.push({ kind: 'blocked-by', target: edge.whole, blocker: edge.part, blockerId: part.hostId });
        }
        if (!edge.sub) {
            continue;
        }
        if ((wholesOf.get(part.number) ?? 0) > 1) {
            manyWholes += 1;
        }
        else if (part.parent?.repo === repo && part.parent.number === whole.number) {
            present += 1;
        }
        else if (part.parent !== undefined) {
            otherParent += 1;
        }
        else {
            writes.push({ kind: 'sub-issue', parent: edge.whole, child: edge.part, childId: part.hostId });
        }
    }
    return { writes, present, otherParent, manyWholes, otherRepo, missing };
}
/** The issues a plan writes on: a sub-issue's parent, a blocker's blocked issue. */
export function changedIssues(plan) {
    return new Set(plan.writes.map((write) => (write.kind === 'sub-issue' ? write.parent.number : write.target.number))).size;
}
