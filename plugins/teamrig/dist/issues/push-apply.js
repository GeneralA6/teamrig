import { targetText } from "./host.js";
import { changeLine, changeWrites } from "./status-push.js";
/**
 * Sends `plan`'s changes through `host`, one line said for each: SET when a change was sent whole, MISSING for a
 * status label the repository lacks (its changes are held, as adding it would make a new label), UNASSIGNED for a
 * login the repository may not assign (its changes go without the assign, as GitHub would drop it silently and the
 * next run would send it again), FAILED with the reason. Each label the plan adds, and each login it assigns, is read
 * once before any write. The first failed write or read stops the
 * repository: the plan is drawn again from the issues as they are on the next run, so nothing is kept to resend and
 * a half-sent change is finished then.
 */
export async function applyPush(host, plan, say) {
    const missing = new Set();
    for (const label of new Set(plan.changes.flatMap((change) => change.add))) {
        const found = await host.labelExists(plan.repo, label);
        if (found.kind === 'failed') {
            say(`FAILED ${plan.repo}: ${found.reason}; nothing was written`);
            return { sent: 0, writes: 0, held: 0, failed: found.reason };
        }
        if (found.kind === 'missing') {
            missing.add(label);
        }
    }
    const unassignable = new Set();
    for (const login of new Set(plan.changes.flatMap((change) => (change.assign === undefined ? [] : [change.assign])))) {
        const found = await host.assigneeExists(plan.repo, login);
        if (found.kind === 'failed') {
            say(`FAILED ${plan.repo}: ${found.reason}; nothing was written`);
            return { sent: 0, writes: 0, held: 0, failed: found.reason };
        }
        if (found.kind === 'missing') {
            unassignable.add(login);
        }
    }
    for (const login of unassignable) {
        const left = plan.changes.filter((change) => change.assign === login).length;
        say(`UNASSIGNED ${plan.repo}: ${login} may not be assigned there (not a person with access to it); its ${left} issue(s) stay unassigned: map the owning session to a login that may under github.owners`);
    }
    const sendable = plan.changes.map((change) => (change.assign !== undefined && unassignable.has(change.assign) ? withoutAssign(change) : change)).filter((change) => changeWrites(change) > 0);
    const held = sendable.filter((change) => change.add.some((label) => missing.has(label)));
    for (const label of missing) {
        const waiting = held.filter((change) => change.add.includes(label)).length;
        say(`MISSING ${plan.repo}: no label ${JSON.stringify(label)}; make it there, and the ${waiting} change(s) adding it go on the next run`);
    }
    let sent = 0;
    let writes = 0;
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
/** `change` with no assign, for a login the repository may not assign. */
function withoutAssign(change) {
    return { target: change.target, task: change.task, status: change.status, add: change.add, remove: change.remove, close: change.close };
}
/** Sends one change: its labels added, then each taken off, then the assign, then the close; the reason of the first failure, if any. */
async function sendChange(host, change) {
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
