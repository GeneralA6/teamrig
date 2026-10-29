import { renamedPath } from "../push-guard/commit-size.js";
import { holdApproved, reviewRoute } from "../push-guard/review-gate.js";
import { gateHoldId } from "./gate-holds.js";
import { holdBinds } from "./review-holds.js";
import { taskOfBranch } from "./review-gate-step.js";
import { missesText, selfMergeMisses } from "./self-merge.js";
function short(sha) {
    return sha.slice(0, 8);
}
/** The files the commits changed, judged where a rename ends, and their changed lines summed over the commits. */
function sizeOf(commits) {
    const changes = commits.flatMap((commit) => commit.files);
    const files = new Set(changes.map((change) => renamedPath(change.path))).size;
    const lines = changes.reduce((sum, change) => sum + (change.added ?? 0) + (change.deleted ?? 0), 0);
    return { files, lines };
}
/** The refusal of a held change: what it missed, who answers it, and the command that asks them. */
function holdRefusal(hold) {
    const range = `${short(hold.base)}..${short(hold.head)}`;
    const note = `gate hold ${hold.id} of ${hold.branch} ${range}`;
    return (`gate hold ${hold.id} keeps ${hold.branch} (${range}) off the default branch: ${missesText(hold.misses)}. ${hold.reviewer} answers it: ` +
        `teamrig set ${hold.task} --status waiting --waits approval:${hold.reviewer} --note "${note}" --session ${hold.session}; ` +
        'merge again once it is approved');
}
/** Whether every gate the change misses now was named by the hold its approval answers. */
function coveredBy(hold, misses) {
    return misses.every((miss) => hold.misses.some((named) => named.gate === miss.gate));
}
/** A change that misses gates: its approved hold lets it merge, else it is held, by its existing hold or a new one. */
async function heldVerdict(setup, ports, change, held, task, misses, facts) {
    const { session, repo, branch } = change;
    const hold = await ports.holds.read(repo, branch);
    if (hold !== undefined && holdBinds(hold, held) && coveredBy(hold, misses)) {
        const createdAt = Date.parse(hold.createdAt);
        const answer = (await ports.taskOf(task))?.answer ?? undefined;
        if (answer !== undefined && holdApproved({ who: hold.reviewer, fallback: undefined }, createdAt, answer)) {
            ports.say(`gate hold ${hold.id} of ${branch}: ${answer.by} approved it`);
            return { kind: 'approved', facts, missed: misses.map((miss) => miss.gate), approvedBy: answer.by };
        }
        if (answer?.verdict === 'declined' && Date.parse(answer.at) > createdAt) {
            const note = answer.note === null ? '' : ` (${answer.note.replace(/\s+/g, ' ')})`;
            return { kind: 'held', reason: `gate hold ${hold.id}: ${answer.by} declined ${task}${note}; change ${branch}, then merge again for a new hold` };
        }
        return { kind: 'held', reason: holdRefusal(hold) };
    }
    const route = reviewRoute('leader', session, setup.tree, setup.roles);
    if (route.kind === 'none') {
        return { kind: 'held', reason: `${branch} misses the self-merge gates (${missesText(misses)}), but ${route.reason}` };
    }
    const made = { ...held, id: gateHoldId(held), task, session, reviewer: route.who, misses, createdAt: new Date(ports.clock.now()).toISOString() };
    await ports.holds.write(made);
    ports.say(`gate hold ${made.id} of ${repo} ${branch}: waits on ${route.who}`);
    return { kind: 'held', reason: holdRefusal(made) };
}
/** The step on one change (see the module comment): merge it with no click, merge it as approved, or why it is held. */
export async function gatedVerdict(setup, ports, change) {
    const { session, repo, branch, base, head } = change;
    const tree = ports.treeOf(head);
    if (tree === undefined) {
        return { kind: 'held', reason: `could not read the tree ${short(head)} makes, so the self-merge gates cannot read its pass record` };
    }
    const commits = ports.commitsOf(base, head);
    if (commits === undefined) {
        return { kind: 'held', reason: `could not read the commits of ${branch} against ${short(base)}, so the self-merge gates cannot weigh them` };
    }
    const taskId = taskOfBranch(branch);
    const task = taskId === undefined ? undefined : await ports.taskOf(taskId);
    const pass = await ports.passOf(tree);
    const misses = selfMergeMisses({ session, repo, reviewGate: change.reviewGate, branch, taskId, task, tree, pass, commits }, setup.commits);
    const facts = { task: taskId, tree, ...sizeOf(commits), checks: pass?.checks ?? [] };
    if (misses.length === 0) {
        ports.say(`self-merge gates of ${branch}: every gate holds, so it merges with no approval`);
        return { kind: 'self', facts };
    }
    if (taskId === undefined || misses.some((miss) => miss.gate === 'task')) {
        return { kind: 'held', reason: `${missesText(misses)}. A missed gate waits on the approval of the branch's task, so ${branch} must name a live task of ${session}'s first` };
    }
    return heldVerdict(setup, ports, change, { repo, branch, base, head, tree }, taskId, misses, facts);
}
