import { ACTIVE_STATUSES } from "../register/model.js";
import { GITHUB_SOURCE } from "../register/model.js";
import { issueTask } from "./map.js";
import { issueTrust } from "./trust.js";
/** How GitHub closed an issue, in the note the sync writes; any other reason is left out. */
const CLOSE_REASONS = new Map([
    ['COMPLETED', 'completed'],
    ['NOT_PLANNED', 'not planned'],
    ['DUPLICATE', 'a duplicate'],
]);
/**
 * Each issue once, as last read: the closed list is read after the open one, so an issue on both lists
 * (closed between the two reads) counts as closed.
 */
export function latestIssues(open, closed) {
    return [...new Map([...open, ...closed].map((issue) => [issue.number, issue])).values()];
}
/** The register's GitHub tasks by ref. Only the import adds them, one per ref (policy.ts). */
export function importedTasks(tasks) {
    const byRef = new Map();
    for (const task of tasks) {
        if (task.source === GITHUB_SOURCE && task.ref !== null && !byRef.has(task.ref)) {
            byRef.set(task.ref, task);
        }
    }
    return byRef;
}
/**
 * The writes that bring the register in step with a repository's issues. An open issue with no task is
 * added when it is trusted or accepted (trust.ts), else left out by its number; a closed one with no task is
 * not, as there is nothing left to do. On a task the import added, only the title, the description, the
 * priority and whether it is open follow GitHub: any active status stands for an open issue, and its owner,
 * notes and plans stay the team's. The title and description follow only while the issue is trusted or
 * accepted, so an outsider's edit after the accept stays on GitHub until someone accepts the issue again;
 * the task keeps the text of the last accept, and stays when its issue stops qualifying.
 */
export function planSync(issues, imported, rules) {
    const perIssue = issues.map((issue) => issueSteps(issue, imported, rules));
    const count = (known, writes) => perIssue.filter((one) => one.known === known && (one.steps.length > 0) === writes).length;
    return {
        steps: perIssue.flatMap((one) => one.steps),
        inserted: count(false, true),
        changed: count(true, true),
        unchanged: count(true, false),
        leftOut: perIssue.flatMap((one) => one.leftOut ?? []).sort((a, b) => a - b),
    };
}
function issueSteps(issue, imported, rules) {
    const wanted = issueTask(issue, rules);
    const task = imported.get(wanted.ref);
    const followsText = issueTrust(issue, rules.acceptLabel) !== 'untrusted';
    if (task === undefined) {
        if (wanted.outcome !== 'open') {
            return { known: false, steps: [] };
        }
        if (!followsText) {
            return { known: false, steps: [], leftOut: issue.number };
        }
        const input = { title: wanted.title, description: wanted.description, owner: wanted.owner, ref: wanted.ref, priority: wanted.priority };
        return { known: false, steps: [{ kind: 'add', ref: wanted.ref, input }] };
    }
    const steps = [];
    const changes = fieldChanges(task, wanted, followsText);
    const names = Object.keys(changes);
    if (names.length > 0) {
        steps.push({ kind: 'update', ref: wanted.ref, id: task.id, changes, note: `${namesText(names)} as on GitHub` });
    }
    const status = statusChange(task, wanted, issue);
    if (status !== undefined) {
        steps.push({ kind: 'status', ref: wanted.ref, id: task.id, input: status });
    }
    return { known: true, steps };
}
/** The field names a sync's note lists: `title`, `title and priority`, `title, description and priority`. */
function namesText(names) {
    const last = names.at(-1) ?? '';
    return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}
/** The priority the issue now gives, and with `followsText` its title and description, where they differ from the task's. */
function fieldChanges(task, wanted, followsText) {
    return {
        ...(!followsText || task.title === wanted.title ? {} : { title: wanted.title }),
        ...(!followsText || task.description === wanted.description ? {} : { description: wanted.description }),
        ...(task.priority === wanted.priority ? {} : { priority: wanted.priority }),
    };
}
/**
 * The status the issue calls for, when the task is not in it: an active status counts as open. A task set done or
 * dropped while its issue is open goes back to open only once GitHub changed the issue after that, as reopening it
 * does, so the team's own close of an issue still open on GitHub stands.
 */
function statusChange(task, wanted, issue) {
    switch (wanted.outcome) {
        case 'open':
            return ACTIVE_STATUSES.includes(task.status) || !changedSince(issue, task.statusAt) ? undefined : { status: 'open', note: 'open on GitHub, changed there since this task closed' };
        case 'done':
            return task.status === 'done' ? undefined : { status: 'done', note: closedNote(issue.stateReason), evidence: wanted.url };
        case 'dropped':
            return task.status === 'dropped' ? undefined : { status: 'dropped', note: closedNote(issue.stateReason) };
    }
}
/** Whether GitHub changed the issue after `at`; an issue gh gave no time for counts as unchanged. */
function changedSince(issue, at) {
    return issue.updatedAt !== undefined && Date.parse(issue.updatedAt) > Date.parse(at);
}
/** The note on a closed issue's task: how GitHub closed it, when it is a reason GitHub names. */
export function closedNote(stateReason) {
    const reason = CLOSE_REASONS.get(stateReason.toUpperCase());
    return reason === undefined ? 'closed on GitHub' : `closed on GitHub as ${reason}`;
}
