import { GITHUB_SOURCE, ISSUE_REF_PREFIX } from "../register/model.js";
import { parseIssueTarget, targetText } from "./host.js";
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
export const STATUS_LABELS = {
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
/**
 * The writes the automatic push sends in an hour at most. GitHub's secondary limit on content-creating calls is also
 * 500 an hour; half of it leaves the same room as PUSH_WRITES_PER_RUN does within the minute.
 */
export const PUSH_WRITES_PER_HOUR = 250;
/**
 * The writes one automatic push sends at most when it runs once per `everyMinutes`: PUSH_WRITES_PER_RUN, lowered so
 * that the runs of an hour stay within PUSH_WRITES_PER_HOUR, with no count kept between runs. An hour holds up to
 * ceil(60 / everyMinutes) runs (every 7 minutes: 9, at 0, 7, ..., 56), so the hourly writes are split by that. Every 0
 * minutes is the automatic sync turned off: no writes.
 */
export function autoPushWrites(everyMinutes) {
    if (everyMinutes <= 0) {
        return 0;
    }
    return Math.min(PUSH_WRITES_PER_RUN, Math.floor(PUSH_WRITES_PER_HOUR / Math.ceil(60 / everyMinutes)));
}
/** The issue a task's status calls for. */
export function issueGoal(status) {
    switch (status) {
        case 'done':
            return { open: false, reason: 'completed' };
        case 'dropped':
            return { open: false, reason: 'not-planned' };
        default:
            return { open: true, label: STATUS_LABELS[status] };
    }
}
/** The writes one change sends: one per label added or taken off, and one for the close. */
export function changeWrites(change) {
    return change.add.length + change.remove.length + (change.close === undefined ? 0 : 1);
}
/** A session's push: the run's writes, closes sent. */
export const SESSION_PUSH = { writesPerRun: PUSH_WRITES_PER_RUN, closes: true };
/**
 * The push of `repo`: for each issue of it a task holds, by `ref: gh:<repo>#<n>`, the writes that make the issue
 * show the task's status, planned against `issues` as the host listed them now (open ones and those closed lately).
 * When a team task and an imported one hold the same issue, the team task speaks for it: the issue is its work.
 * The run sends at most `limits.writesPerRun` writes; the rest is deferred. Without `limits.closes` a closing change
 * is held instead, taking none of the run's writes.
 */
export function planPush(repo, issues, tasks, limits = SESSION_PUSH) {
    const listed = new Map(issues.filter((issue) => issue.repo === repo).map((issue) => [issue.number, issue]));
    const planned = [];
    const closedActive = [];
    const unlisted = [];
    let unchanged = 0;
    for (const [target, task] of [...holders(repo, tasks)].sort(([a], [b]) => a - b).map(([number, holder]) => [{ repo, number }, holder])) {
        const issue = listed.get(target.number);
        const goal = issueGoal(task.status);
        if (issue === undefined) {
            // The list holds every open issue, so one it left out is closed (or gone): as a closed task wants it.
            if (goal.open) {
                unlisted.push({ target, task: task.id, status: task.status });
            }
            else {
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
        }
        else {
            planned.push(change);
        }
    }
    const heldCloses = limits.closes ? [] : planned.filter((change) => change.close !== undefined);
    const sendable = limits.closes ? planned : planned.filter((change) => change.close === undefined);
    const { changes, deferred } = withinRun(sendable, limits.writesPerRun);
    return { repo, changes, deferred, heldCloses, unchanged, closedActive, unlisted };
}
/** The task speaking for each issue number of `repo` a task holds: a team task over one the import added. */
function holders(repo, tasks) {
    const byNumber = new Map();
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
export function heldIssue(task) {
    return task.ref?.startsWith(ISSUE_REF_PREFIX) === true ? parseIssueTarget(task.ref.slice(ISSUE_REF_PREFIX.length)) : undefined;
}
/**
 * The writes for one listed issue, or undefined when it already shows its task's status. A closing issue loses its
 * status labels too, so a closed issue never shows work as still going on.
 */
function changeFor(target, task, issue, goal) {
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
function withinRun(planned, writesPerRun) {
    const changes = [];
    const deferred = [];
    let writes = 0;
    for (const change of planned) {
        const cost = changeWrites(change);
        if (deferred.length === 0 && writes + cost <= writesPerRun) {
            changes.push(change);
            writes += cost;
        }
        else {
            deferred.push(change);
        }
    }
    return { changes, deferred };
}
/** One change on one line: the issue, its task and status, then each write. */
export function changeLine(change) {
    const writes = [
        ...(change.close === undefined ? [] : [`close as ${change.close}`]),
        ...change.add.map((label) => `add ${label}`),
        ...change.remove.map((label) => `take off ${label}`),
    ];
    return `${change.close === undefined ? 'LABEL' : 'CLOSE'} ${targetText(change.target)} ${change.task} ${change.status}: ${writes.join(', ')}`;
}
