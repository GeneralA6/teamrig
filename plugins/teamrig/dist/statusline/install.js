import { isRecord, stringField } from "../core/guards.js";
/**
 * How `teamrig statusline install` and `uninstall` change Claude Code's `statusLine` setting. With no
 * status line, the kit's launcher becomes it. With one already there, the launcher goes in front of it
 * in a pipe (`<launcher> --pass | <theirs>`): it saves the week's reading, then hands the same input on,
 * so their command runs and shows exactly as before. A launcher left with `--pass` and nothing piped after it, as when
 * their command was cut out by hand, makes Claude Code show the raw status input, so install puts the bare launcher
 * back. Uninstall takes the launcher back out.
 */
/** The settings key Claude Code reads the status line from. */
export const STATUS_LINE_KEY = 'statusLine';
const PASS_PIPE = ' --pass | ';
/** The command that runs the launcher. Claude Code runs it in a shell, where forward slashes work on every system. */
export function launcherCommand(launcher) {
    return `node "${launcher.replaceAll('\\', '/')}"`;
}
/** Puts the launcher in as the status line, in front of the one already there. */
export function planInstall(settings, launcher) {
    const own = launcherCommand(launcher);
    const current = currentCommand(settings);
    if (!current.ok) {
        return current;
    }
    const before = current.value;
    if (before === undefined) {
        const after = own;
        return { ok: true, value: { settings: { ...settings, [STATUS_LINE_KEY]: { type: 'command', command: after } }, before, after } };
    }
    if (passesToNothing(before, own)) {
        return { ok: true, value: { settings: withCommand(settings, own), before, after: own } };
    }
    if (isLaunchedBy(before, own)) {
        return { ok: true, value: { settings: undefined, before, after: before } };
    }
    const operator = compoundOperator(before);
    if (operator !== undefined) {
        return {
            ok: false,
            problem: `the status line already there is a shell line with ${operator}, which the pipe in front would split: put it in a script, make that the status line, and run install again`,
        };
    }
    const after = `${own}${PASS_PIPE}${before}`;
    return { ok: true, value: { settings: withCommand(settings, after), before, after } };
}
/** Takes the launcher back out: the status line that was there before it returns, or none when there was none. */
export function planUninstall(settings, launcher) {
    const own = launcherCommand(launcher);
    const current = currentCommand(settings);
    if (!current.ok) {
        return current;
    }
    const before = current.value;
    if (before === undefined || !isLaunchedBy(before, own)) {
        return { ok: true, value: { settings: undefined, before, after: before } };
    }
    if (before === own || passesToNothing(before, own)) {
        const rest = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== STATUS_LINE_KEY));
        return { ok: true, value: { settings: rest, before, after: undefined } };
    }
    if (!before.startsWith(`${own}${PASS_PIPE}`)) {
        return { ok: false, problem: `the status line starts with the launcher but was changed by hand: edit ${STATUS_LINE_KEY}.command yourself` };
    }
    const after = before.slice(own.length + PASS_PIPE.length);
    return { ok: true, value: { settings: withCommand(settings, after), before, after } };
}
function isLaunchedBy(command, own) {
    return command === own || command.startsWith(`${own} `);
}
/** The launcher passing the status input on with no command after it, a pipe left open or none: Claude Code would show that input raw. */
function passesToNothing(command, own) {
    return command.startsWith(`${own} `) && /^--pass(\s*\|)?$/.test(command.slice(own.length).trim());
}
/** The settings with the status line's command set to `command`, its other fields kept. */
function withCommand(settings, command) {
    return { ...settings, [STATUS_LINE_KEY]: { ...statusLineOf(settings), command } };
}
function statusLineOf(settings) {
    const value = settings[STATUS_LINE_KEY];
    return isRecord(value) ? value : {};
}
/** The status line's command; undefined when there is no status line. A status line without a command is refused. */
function currentCommand(settings) {
    const value = settings[STATUS_LINE_KEY];
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    const command = isRecord(value) ? stringField(value, 'command') : undefined;
    return command === undefined ? { ok: false, problem: `${STATUS_LINE_KEY} has no command string, so nothing can be added in front of it` } : { ok: true, value: command };
}
/**
 * The first `&&`, `||`, `;` or line break outside quotes, named for a message: a pipe in front of such a
 * line would feed only the part before it. A backslash escapes the next character, as in a POSIX shell.
 */
export function compoundOperator(command) {
    let quote;
    for (let at = 0; at < command.length; at += 1) {
        const char = command[at];
        if (char === '\\' && quote !== "'") {
            at += 1;
        }
        else if (quote !== undefined) {
            quote = char === quote ? undefined : quote;
        }
        else if (char === '"' || char === "'") {
            quote = char;
        }
        else if (char === '&' || char === '|') {
            if (command[at + 1] === char) {
                return `"${char}${char}"`;
            }
        }
        else if (char === ';') {
            return '";"';
        }
        else if (char === '\n' || char === '\r') {
            return 'a line break';
        }
    }
    return undefined;
}
