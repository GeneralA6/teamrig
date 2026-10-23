/**
 * The register commands every session of a team may run on its own: each only reads or writes the team's own files.
 * Each is a command name of the CLI, which a test holds it to.
 */
export const REGISTER_COMMANDS = [
    'start',
    'add',
    'set',
    'update',
    'verify',
    'list',
    'show',
    'check',
    'plan',
    'budget',
    'rules',
    'refresh',
    'inbox read',
    'inbox status',
    'inbox add',
    'who',
    'rename',
];
/** The tag every line of the team's starts with, a space included. */
export function kitTag(team) {
    return `[teamrig ${team}] `;
}
/** The team's lines, in order: protected branches, the register, heavy and test. */
export function kitLines(facts) {
    const tag = kitTag(facts.team);
    return [`${tag}${branchesLine(facts)}`, `${tag}${registerLine(facts)}`, `${tag}${wrappersLine()}`];
}
function branchesLine({ lead, pushGuard }) {
    return (`Protected branches: ${pushGuard.protectedBranches.join(', ')}. ${normalPush(pushGuard.pushToProtected, lead)} ` +
        'A force-push, a --mirror push or deleting one is refused, and a --force-with-lease push asks. ' +
        "Every session edits on its own branch in its own git worktree, never in a repo's main checkout.");
}
function normalPush(mode, lead) {
    switch (mode) {
        case 'ask':
            return 'A normal push to one asks the person.';
        case 'allow':
            return 'A normal push to one goes through with a note.';
        case 'lead':
            return (`A normal push to one goes through only for the lead (session ${lead}) or for a session whose waiting task the ` +
                'lead approved with `teamrig approve`; any other session is refused.');
    }
}
function registerLine({ team, home }) {
    const names = REGISTER_COMMANDS.map((name) => `teamrig ${name}`).join(', ');
    return `The task register: every session may run ${names} for team ${team}; they write only under ${home}/.`;
}
function wrappersLine() {
    return ('`teamrig heavy ... -- <cmd>` and `teamrig test ... -- <cmd>` run the session\'s own build, test or script on this ' +
        'host (heavy waits for the host lock, test records the result); neither grants anything, so judge the command ' +
        'after `--` as if it ran alone.');
}
