import { launch, programName, staticWord } from "../push-guard/launchers.js";
import { Location } from "../push-guard/location.js";
import { redirectsInput, stdinUse } from "../push-guard/stdin.js";
import { parseShell } from "../push-guard/tokenizer.js";
import { resolveLiteralVariables } from "../push-guard/variables.js";
/** Nested scripts deeper than this are not read, as in the push guard. */
const MAX_SCRIPT_DEPTH = 8;
/** The programs `command` starts, in the order it starts them. */
export function programsOf(command, context) {
    const runs = [];
    visitScript(staticWord(command), context.dialect, new Location(context.cwd, context.home), 0, runs);
    return runs;
}
/** Visits each command of a script; a plain `cat` hands its stdin down a pipe, so `cat <<EOF | bash` runs the body. */
function visitScript(script, dialect, location, depth, runs) {
    if (depth > MAX_SCRIPT_DEPTH) {
        return;
    }
    const parsed = parseShell(script.text, dialect);
    const commands = dialect === 'bash' ? resolveLiteralVariables(parsed) : parsed.commands;
    let piped;
    for (const command of commands) {
        let stdin = command.stdin;
        if (piped !== undefined && command.nesting <= piped.nesting) {
            stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
            piped = undefined;
        }
        location.enter(command.subshells);
        const launched = visitCommand(command.words, dialect, location, depth, stdin, runs);
        if (stdin !== undefined) {
            piped = launched !== undefined && stdinUse(command, launched) === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
        }
    }
}
/** Visits one simple command; returns what it starts, or undefined for a `cd`. */
function visitCommand(words, dialect, location, depth, stdin, runs) {
    if (location.apply(words, dialect)) {
        return undefined;
    }
    const launched = launch(words, dialect, stdin);
    if (launched.kind === 'script') {
        const inner = location.child();
        launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
        visitScript(launched.script, launched.dialect, inner, depth + 1, runs);
        if (launched.sameShell) {
            location.adopt(inner);
        }
    }
    else if (launched.kind === 'program' && !launched.program.dynamic) {
        const inner = location.child();
        launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
        runs.push({ name: programName(launched.program.text), args: launched.args, dir: inner.dir });
    }
    return launched;
}
