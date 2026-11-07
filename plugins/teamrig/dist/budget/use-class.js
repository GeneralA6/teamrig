import { isShell } from "../push-guard/launchers.js";
import { shellLineRunsOf, teamrigArgsOf } from "./run-work.js";
/**
 * Which tool calls keep the team running rather than do its work, as T1995 measured them: the rollup's classes
 * (`rollup.ts`) rest on this. Anything not named here is work, so a call this cannot read counts as work and the
 * coordination share can only read low.
 */
/** The teamrig commands that read or write the register, the inbox or the plan. A run of tests or a merge is work. */
const COORDINATION_SUBCOMMANDS = new Set([
    'inbox',
    'start',
    'check',
    'list',
    'show',
    'add',
    'set',
    'update',
    'verify',
    'who',
    'files',
    'goal',
    'plan',
    'approve',
    'budget',
    'refresh',
    'meeting',
    'decisions',
    'help',
    '--help',
    '--version',
]);
/** Shell scaffolding around a command, never the command. `cd`, a loop's keywords and an assignment leave no program at all. */
const NEUTRAL_PROGRAMS = new Set(['echo', 'date', 'printf', 'true', 'export', 'write-output', 'write-host', 'get-date']);
/** Programs that count as coordination only on a handover, which is the session's own hand-off, not a file of the work. */
const HANDOVER_PROGRAMS = new Set(['cat', 'sed', 'head', 'tail', 'type', 'get-content', 'cp', 'tee', 'mv']);
const HANDOVER_TOOLS = new Set(['Read', 'Edit', 'Write']);
const HANDOVER_PATH = /[\\/]handover[\\/]/;
const MESSAGE_TOOLS = new Set(['SendMessage', 'ListAgents']);
const COORDINATION_SKILLS = new Set([
    'team-start-of-block',
    'team-assign-task',
    'teamrig:approvals',
    'teamrig:teamrig-guide',
    'teamrig:daily-meeting',
    'lead-daily-meeting',
    'lead-budget-checkpoint',
]);
/** teamrig run from its own sources, as a session working on teamrig does; `teamrigArgsOf` knows only the build. */
const TEAMRIG_SOURCE = /(?:^|[\\/])cli[\\/]main\.ts$/;
/** A teamrig command's own arguments, from the build or the sources; undefined for any other program. */
function teamrigWordsOf(run) {
    const built = teamrigArgsOf(run);
    if (built !== undefined || run.name !== 'node') {
        return built;
    }
    const [script, ...args] = run.args;
    return script !== undefined && TEAMRIG_SOURCE.test(script.text) ? args : undefined;
}
/** Whether `run` reads or writes a handover: named as an argument, or as the file a redirection opens. */
function touchesHandover(run) {
    const targets = run.redirections.flatMap(({ target }) => (target === undefined ? [] : [target]));
    return [...run.args, ...targets].some((word) => HANDOVER_PATH.test(word.text));
}
/** Whether one program is coordination. A later pipe stage only shapes the output of the one before, so it does not decide. */
function isCoordinationRun(run) {
    if (run.piped) {
        return true;
    }
    const teamrigWords = teamrigWordsOf(run);
    if (teamrigWords !== undefined) {
        return COORDINATION_SUBCOMMANDS.has(teamrigWords[0]?.text ?? '');
    }
    return NEUTRAL_PROGRAMS.has(run.name) || (HANDOVER_PROGRAMS.has(run.name) && touchesHandover(run));
}
/** A shell handed a script file: the parser leaves it a bare command with no program, and the script's work is unknown. */
function runsScript(bare) {
    return isShell(bare.words[0]?.text ?? '');
}
/**
 * Whether a tool call only coordinates. A shell call must start nothing else, and nothing it runs may be unknown until
 * it runs: `opaque`, `fedShells` and a script a shell runs count as work. Any other bare command is a keyword or an
 * assignment, which runs nothing. `bash < script.sh` leaves no trace in `runsOf`, so it reads as coordination.
 */
export function isCoordinationTool(tool) {
    const lineRuns = shellLineRunsOf(tool);
    if (lineRuns !== undefined) {
        return lineRuns.opaque.length === 0 && lineRuns.fedShells.length === 0 && !lineRuns.bare.some(runsScript) && lineRuns.programs.every(isCoordinationRun);
    }
    if (HANDOVER_TOOLS.has(tool.name)) {
        return tool.path !== undefined && HANDOVER_PATH.test(tool.path);
    }
    if (tool.name === 'Skill') {
        return tool.skill !== undefined && COORDINATION_SKILLS.has(tool.skill);
    }
    return MESSAGE_TOOLS.has(tool.name);
}
