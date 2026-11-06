import { launch, programName, staticWord } from "../push-guard/launchers.js";
import { Location } from "../push-guard/location.js";
import { redirectsInput, stdinUse } from "../push-guard/stdin.js";
import { parseShell } from "../push-guard/tokenizer.js";
import { resolveLiteralVariables } from "../push-guard/variables.js";
/** The outlet of the line's own commands: the screen. */
const SCREEN = { pipe: undefined, substitution: undefined };
/** Nested scripts deeper than this are not read, as in the push guard. */
const MAX_SCRIPT_DEPTH = 8;
/** A separator that pipes a command's output into the next one: `|`, `|&`, `)|` after a group, or `|(` before a subshell, not `||`. */
const PIPE_END = /(?:^|[^|])\|&?[\n(]*$/;
/** What `command` runs, each in the order it runs. */
export function runsOf(command, context) {
    const runs = { programs: [], bare: [], opaque: [], fedShells: [] };
    visitScript(staticWord(command), context.dialect, new Location(context.cwd, context.home), 0, false, runs, SCREEN, false);
    return runs;
}
/** The programs `command` starts, in the order it starts them. */
export function programsOf(command, context) {
    return runsOf(command, context).programs;
}
/**
 * Visits each command of a script; a plain `cat` hands its stdin down a pipe, so `cat <<EOF | bash` runs the body.
 * `runner` is true when a teamrig runner started the script; `outlet` takes the output of its commands that send it nowhere else;
 * `fed` is true when the command that started it has a fed stdin, which its own commands inherit.
 */
function visitScript(script, dialect, location, depth, runner, runs, outlet, fed) {
    if (depth > MAX_SCRIPT_DEPTH) {
        return;
    }
    const parsed = parseShell(script.text, dialect);
    // The line's own shell has the user's HOME; a script it starts may be handed another (`HOME=x bash -c`).
    const commands = dialect === 'bash' ? resolveLiteralVariables(parsed, depth === 0 ? location.home : undefined) : parsed.commands;
    let piped;
    /** Per nesting depth: the pipe the last command read at that depth sends its output into, if it pipes. */
    const pipes = new Map();
    /** Commands inside a substitution still waiting for the command after them that holds it, deepest last. */
    const unheld = [];
    /** PowerShell: the groups the reader is inside, innermost last. */
    const groups = [];
    for (const command of commands) {
        const pipeIn = pipes.get(command.nesting);
        const ownPipe = PIPE_END.test(command.terminator) ? { into: undefined } : undefined;
        if (ownPipe === undefined) {
            pipes.delete(command.nesting);
        }
        else {
            pipes.set(command.nesting, ownPipe);
        }
        const ownSubstitution = command.nesting > 0 ? { holder: undefined } : undefined;
        const grouped = dialect === 'powershell' && groups.length > 0;
        const outermost = command.nesting === 0 && !grouped;
        /** In `X (a) | y`, the pipe after the `)` takes the output of X, not of a. */
        const closed = dialect === 'powershell' && ownPipe !== undefined ? closedBeforePipe(command.terminator, groups) : undefined;
        const pipe = closed?.held === true ? undefined : (ownPipe ?? (outermost ? outlet.pipe : undefined));
        if (closed?.held === true && closed.holder !== undefined) {
            closed.holder.pipe = ownPipe;
        }
        const substitution = ownSubstitution ?? (grouped ? { holder: groups.at(-1)?.holder } : outlet.substitution);
        let stdin = command.stdin;
        if (piped !== undefined && command.nesting <= piped.nesting) {
            stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
            piped = undefined;
        }
        location.enter(command.subshells);
        const inlet = { fromPipe: pipeIn !== undefined, text: stdin, fed: pipeIn !== undefined || stdin !== undefined || (fed && command.nesting === 0) };
        const visited = visitCommand(command, inlet, { pipe, substitution }, dialect, location, depth, runner, runs);
        if (pipeIn !== undefined) {
            pipeIn.into = visited?.run;
        }
        const holder = visited?.run ?? visited?.bare;
        for (let waiting = unheld.at(-1); waiting !== undefined && waiting.nesting > command.nesting; waiting = unheld.at(-1)) {
            waiting.slot.holder = holder;
            unheld.pop();
        }
        if (ownSubstitution !== undefined) {
            unheld.push({ nesting: command.nesting, slot: ownSubstitution });
        }
        if (dialect === 'powershell') {
            trackGroups(command.terminator, { holder, held: command.words.length > 0 }, groups);
        }
        if (stdin !== undefined) {
            piped = visited !== undefined && stdinUse(command, visited.launched) === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
        }
    }
}
/** Visits one simple command; returns what it starts, or undefined for a `cd`. */
function visitCommand(command, inlet, outlet, dialect, location, depth, runner, runs) {
    if (location.apply(command.words, dialect)) {
        return undefined;
    }
    const launched = launch(command.words, dialect, inlet.text);
    if (launched.kind === 'script') {
        const inner = location.child();
        launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
        visitScript(launched.script, launched.dialect, inner, depth + 1, runner || launched.runner, runs, outlet, inlet.fed);
        if (launched.sameShell) {
            location.adopt(inner);
        }
    }
    else if (launched.kind === 'program' && !launched.program.dynamic) {
        const inner = location.child();
        launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
        const run = {
            name: programName(launched.program.text),
            program: launched.program,
            args: launched.args,
            dialect,
            dir: inner.dir,
            redirections: command.redirections,
            stdin: inlet.text,
            piped: inlet.fromPipe,
            runner: runner || launched.runner,
            pipe: outlet.pipe,
            captured: launched.captured,
            substitution: outlet.substitution,
        };
        runs.programs.push(run);
        return { launched, run, bare: undefined };
    }
    else if (launched.kind === 'opaque' && launched.command !== undefined) {
        runs.opaque.push({ ...launched.command, dialect });
    }
    else if (launched.kind === 'opaque' && launched.stdinScript === true && inlet.fed) {
        runs.fedShells.push(dialect);
    }
    else if (launched.kind === 'nothing' && command.words.length > 0) {
        const bare = { words: command.words, dialect, redirections: command.redirections, pipe: outlet.pipe, substitution: outlet.substitution };
        runs.bare.push(bare);
        return { launched, run: undefined, bare };
    }
    return { launched, run: undefined, bare: undefined };
}
/** PowerShell: opens `group` at each `(` of the terminator, and closes one at each `)`. */
function trackGroups(terminator, group, groups) {
    for (const char of terminator) {
        if (char === '(') {
            groups.push(group);
        }
        else if (char === ')') {
            groups.pop();
        }
    }
}
/** PowerShell: the last group a terminator ending in a pipe closes before it, whose holder's output the pipe takes. */
function closedBeforePipe(terminator, groups) {
    const open = [...groups];
    let closed;
    for (const char of terminator) {
        if (char === '(') {
            open.push({ holder: undefined, held: false });
        }
        else if (char === ')') {
            closed = open.pop();
        }
    }
    return closed;
}
