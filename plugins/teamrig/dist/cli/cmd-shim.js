/**
 * cmd.exe ends `%*` at the first line break, so the `teamrig.cmd` shim, which PowerShell and cmd run, hands the CLI
 * only the first line of a multi-line argument and none of the arguments after it. The shim also sets this variable to
 * cmd's whole command line (`!CMDCMDLINE!`, read with delayed expansion, keeps the line breaks), for `shimArgs`.
 */
export const CMD_SHIM_LINE_ENV = 'TEAMRIG_CMD_LINE';
/**
 * The arguments a run through the shim was given. With no line break in cmd's command line `given` is whole; with
 * one they are rebuilt from the line, once cutting it at that break the way cmd did gives exactly `given`, so the line
 * is this run's own. Undefined when it does not: the rest of the command line cannot be read back.
 */
export function shimArgs(given, line) {
    if (line === undefined || !/[\r\n]/.test(line)) {
        return given;
    }
    const command = commandOf(line);
    if (command === undefined) {
        return undefined;
    }
    const lineBreak = command.indexOf('\n');
    const cut = (lineBreak === -1 ? command : command.slice(0, lineBreak)).replaceAll('\r', '');
    return sameArgs(windowsArgs(cut).slice(1), given) ? windowsArgs(command).slice(1) : undefined;
}
/** Why a run whose command line `shimArgs` cannot read back does nothing, and the ways to run it whole. */
export function cutLineMessage(script) {
    return ('the command line held a line break, and cmd.exe, which runs teamrig.cmd for PowerShell and cmd, dropped ' +
        'everything after it, so nothing was done. Run the command from Bash, keep each argument on one line, or run ' +
        `node "${script}" with the same arguments.`);
}
/** The command cmd ran: what follows its first `/c` or `/k` switch, less the outer quotes cmd takes off (`cmd /?`). */
function commandOf(line) {
    const runSwitch = /(?:^|[\s"])\/[ck](?=[\s"])/i.exec(line);
    if (runSwitch === null) {
        return undefined;
    }
    const command = line.slice(runSwitch.index + runSwitch[0].length).replace(/^[ \t]+/, '');
    if (!command.startsWith('"')) {
        return command;
    }
    const last = command.lastIndexOf('"');
    return command.slice(1, last) + command.slice(last + 1);
}
function sameArgs(left, right) {
    return left.length === right.length && left.every((arg, index) => arg === right[index]);
}
function isBlank(char) {
    return char === ' ' || char === '\t';
}
/**
 * Splits a Windows command line the way the C runtime fills `argv`, which Node's `process.argv` comes from. The first
 * word is the program, whose quotes only group. After it spaces and tabs part the arguments outside quotes (a line
 * break does not); 2n backslashes and a `"` give n backslashes and open or close the quotes, 2n+1 give n and a literal
 * `"`; any other backslash is literal; inside quotes `""` is a literal `"` and the quotes stay open.
 */
export function windowsArgs(line) {
    let at = 0;
    let quoted = false;
    let program = '';
    while (at < line.length && (quoted || !isBlank(line.charAt(at)))) {
        const char = line.charAt(at);
        if (char === '"') {
            quoted = !quoted;
        }
        else {
            program += char;
        }
        at += 1;
    }
    const args = [program];
    for (;;) {
        while (isBlank(line.charAt(at))) {
            at += 1;
        }
        if (at >= line.length) {
            return args;
        }
        let arg = '';
        quoted = false;
        while (at < line.length && (quoted || !isBlank(line.charAt(at)))) {
            const char = line.charAt(at);
            if (char === '\\') {
                const start = at;
                while (line.charAt(at) === '\\') {
                    at += 1;
                }
                const backslashes = at - start;
                if (line.charAt(at) !== '"') {
                    arg += '\\'.repeat(backslashes);
                }
                else if (backslashes % 2 === 1) {
                    arg += `${'\\'.repeat((backslashes - 1) / 2)}"`;
                    at += 1;
                }
                else {
                    arg += '\\'.repeat(backslashes / 2);
                }
            }
            else if (char === '"' && quoted && line.charAt(at + 1) === '"') {
                arg += '"';
                at += 2;
            }
            else if (char === '"') {
                quoted = !quoted;
                at += 1;
            }
            else {
                arg += char;
                at += 1;
            }
        }
        args.push(arg);
    }
}
