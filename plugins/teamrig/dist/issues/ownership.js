import { KIT_NAME } from "../core/home.js";
import { targetText } from "./host.js";
/** A task branch: `t<id>-<words>`, as each change's branch is named. */
const TASK_BRANCH = /^t([1-9][0-9]*)-/iu;
/** The task id a branch is named for, `T12` for `t12-fix`; undefined for any other branch. */
export function branchTaskId(branch) {
    const digits = TASK_BRANCH.exec(branch)?.[1];
    return digits === undefined ? undefined : `T${digits}`;
}
/** Decides whether `facts.caller` may write on `facts.target`. */
export async function writeRight(facts) {
    const { caller, target, tasks } = facts;
    const ownTask = tasks.find((task) => task.owner === caller && task.ref === facts.ref);
    if (ownTask !== undefined) {
        return { kind: 'allowed', why: `${ownTask.id} of ${caller} has it as its ref` };
    }
    const admin = await facts.admin();
    if (admin.session === caller) {
        return { kind: 'allowed', why: `${caller} is the GitHub admin` };
    }
    const shown = targetText(target);
    const head = await facts.head();
    if (head.kind === 'failed') {
        return { kind: 'unknown', reason: `could not tell whose ${shown} is: ${head.reason}` };
    }
    const branchTask = head.kind === 'pull' && head.repo === target.repo ? branchTaskId(head.branch) : undefined;
    if (branchTask !== undefined && tasks.some((task) => task.id === branchTask && task.owner === caller)) {
        return { kind: 'allowed', why: `its branch is one of ${branchTask} of ${caller}` };
    }
    return {
        kind: 'refused',
        reason: `${caller} may write only on its own issues and pull requests, and ${shown} is not one: no task of ${caller} has it as its ref, and ${headText(head, target.repo, caller)}; ${admin.text}`,
    };
}
/** Why the pull request's head does not make it the caller's. */
function headText(head, repo, caller) {
    if (head.kind === 'no-pull') {
        return 'it is no pull request';
    }
    if (head.repo !== repo) {
        return `its pull request's branch ${head.branch} is in ${head.repo ?? 'a fork since deleted'}, not ${repo}`;
    }
    return `its pull request's branch ${head.branch} is no t<id>- branch of a task of ${caller}`;
}
/** How a refusal names the admin, who may write where the caller may not. */
export function adminText(session, broken) {
    if (session !== undefined) {
        return `the GitHub admin, ${session}, writes on the rest`;
    }
    const why = broken === undefined ? 'none is set' : `the role reads broken (${broken})`;
    return `the GitHub admin writes on the rest, and ${why}: the owner names one with ${KIT_NAME} owner github-admin <session>`;
}
