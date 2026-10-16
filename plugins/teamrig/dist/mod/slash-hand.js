/**
 * `/teamrig <command> [args]` in a Claude Code tab. The plugin's mod (`hooks/register.ts`) registers the command in
 * every session and answers it with a `SlashHand`: the hand runs the plugin's own CLI (`hook slash-command`,
 * src/cli/commands/slash.ts) with the typed text, the tab's session and where the line came from, and shows what the
 * CLI printed as the command's output, so no model turn runs and no tokens are spent. Which lines run is the CLI's
 * call; the hand only asks the person when the CLI printed a line to agree to (exit ASK_EXIT), and sends that line
 * back once they chose to run it.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to a module
 * the mod imports as it is.
 */
/** The slash command; the same word as the CLI's name. */
export const SLASH_COMMAND = 'teamrig';
export const SLASH_ARGUMENT_HINT = '<command> [args]';
export const SLASH_DESCRIPTION = "Run a teamrig command here; a read runs at once as this tab's session";
/** What the tab shows when the hook itself failed, before or after the command ran. */
export const SLASH_HOOK_FAILED = `/${SLASH_COMMAND} could not run here; run ${SLASH_COMMAND} in a terminal, or /reload-plugins and try again.`;
/** The CLI's exit when it printed a line the person must agree to first (src/cli/runtime.ts EXIT.ask). */
export const ASK_EXIT = 4;
/** The choice that runs the line; anything else, a dismissed dialog included, runs nothing. */
export const RUN_CHOICE = 'Run it';
export const CANCEL_CHOICE = 'Cancel';
/** The command line that runs the plugin's CLI for one `/teamrig` line, given the plugin's folder. */
export function slashCliArgv(pluginRoot) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', 'slash-command'];
}
/** How long a command may run before it is stopped: `budget` reads every transcript of the week. */
export const TIMEOUT_MS = 180_000;
/** The most of a command's output shown in the tab; the rest is counted, and a terminal shows it all. */
export const MAX_LINES = 250;
export const MAX_CHARS = 20_000;
/** The most of the error output shown under a failed command's output. */
export const MAX_ERROR_LINES = 40;
export const MAX_ERROR_CHARS = 4_000;
/** The line as the person typed it, after the command's name. */
function typedLine(args) {
    const typed = args.trim();
    return typed === '' ? SLASH_COMMAND : `${SLASH_COMMAND} ${typed}`;
}
/** A text's first lines within both limits, and how many lines were left out. */
export function capLines(text, maxLines, maxChars) {
    const lines = text.split('\n');
    const kept = [];
    let chars = 0;
    for (const line of lines) {
        if (kept.length === maxLines || chars + line.length > maxChars) {
            break;
        }
        kept.push(line);
        chars += line.length + 1;
    }
    return { kept: kept.join('\n'), hidden: lines.length - kept.length };
}
/** A code fence longer than any run of backticks in the text, so the output shows exactly as printed. */
function fenced(text) {
    const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}text\n${text}\n${fence}`;
}
/** Text without the line breaks and blanks a command prints last. */
function trimEnd(text) {
    return text.replace(/\s+$/, '');
}
/**
 * What the tab shows for a finished run: the output in a code fence, at most MAX_LINES lines and MAX_CHARS
 * characters, then the count of lines left out. A failed run adds its error output, at most MAX_ERROR_LINES
 * lines, and its exit code. Output Claude Code itself cut at 4 MiB is said to be cut.
 */
export function resultText(args, run) {
    const typed = typedLine(args);
    const stdout = capLines(trimEnd(run.stdout), MAX_LINES, MAX_CHARS);
    const failed = run.exitCode !== 0;
    const stderr = failed ? capLines(trimEnd(run.stderr), MAX_ERROR_LINES, MAX_ERROR_CHARS) : { kept: '', hidden: 0 };
    const shown = [stdout.kept, stderr.kept].filter((part) => part !== '').join('\n');
    const notes = [];
    if (stdout.hidden > 0 || run.isStdoutTruncated) {
        notes.push(`${stdout.hidden > 0 ? `${stdout.hidden} more lines not shown` : 'More output not shown'}: run ${typed} in a terminal for all of it.`);
    }
    if (stderr.hidden > 0 || (failed && run.isStderrTruncated)) {
        notes.push('More error output not shown.');
    }
    if (failed) {
        notes.push(`${typed} ended with exit code ${run.exitCode}.`);
    }
    const body = shown === '' ? (failed ? '' : `${typed}: done, nothing printed.`) : fenced(shown);
    return [body, ...notes].filter((part) => part !== '').join('\n');
}
/** What the tab shows when the command could not run or did not finish. */
export function failureText(args, error) {
    const why = error instanceof Error ? error.message : String(error);
    return `${typedLine(args)} did not finish: ${why}. A command is stopped after ${TIMEOUT_MS / 1000} s; a terminal runs it with no limit.`;
}
/** What the tab shows when the person did not choose to run the line. */
export function notRunText(line) {
    return `Not run. To run it, type /${line}, or ${line} in a terminal.`;
}
/** What the tab shows when the line to agree to changed while the person was asked. */
export function changedText(line) {
    return `Not run: the line changed while you were asked, to ${line}. Type /${SLASH_COMMAND} again to see it.`;
}
/** Answers `/teamrig` lines in one tab. */
export class SlashHand {
    host;
    constructor(host) {
        this.host = host;
    }
    /**
     * Answers one line: shows `teamrig <command>: running` under the prompt, runs the CLI with the tab's session id,
     * folder and project root, the typed text and its origin (Claude Code's `PromptOrigin.kind`) on stdin, and clears
     * the line again, whatever happened. When the CLI prints a line to agree to, it asks the person, and runs that
     * line only on RUN_CHOICE. Waiting on the process or the person does not count against the hook's time budget.
     */
    async answer(args, origin) {
        const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
        const run = (agreed) => {
            const stdin = JSON.stringify({ session_id: sessionId, cwd, args, origin, ...(agreed === undefined ? {} : { agreed }) });
            return this.host.cli(stdin, { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root }, cwd);
        };
        const running = `${typedLine(args)}: running`;
        this.host.status(running);
        try {
            const first = await run(undefined);
            if (first.exitCode !== ASK_EXIT) {
                return { text: resultText(args, first), exitCode: first.exitCode };
            }
            const line = trimEnd(first.stdout);
            this.host.status(undefined);
            if (!(await this.agrees(line))) {
                return { text: notRunText(line), exitCode: ASK_EXIT };
            }
            this.host.status(running);
            const agreed = await run(line);
            if (agreed.exitCode === ASK_EXIT) {
                return { text: changedText(trimEnd(agreed.stdout)), exitCode: ASK_EXIT };
            }
            return { text: resultText(args, agreed), exitCode: agreed.exitCode };
        }
        catch (error) {
            return { text: failureText(args, error), exitCode: 1 };
        }
        finally {
            this.host.status(undefined);
        }
    }
    /** Whether the person chose to run the line; a dismissed dialog, or none to show, is a no. */
    async agrees(line) {
        try {
            return (await this.host.ask(`Run ${line}?`, [RUN_CHOICE, CANCEL_CHOICE])) === RUN_CHOICE;
        }
        catch {
            return false;
        }
    }
}
