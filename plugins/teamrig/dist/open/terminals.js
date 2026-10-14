import { shellCommand } from "./quote.js";
/**
 * Windows Terminal re-reads its command line: `;` starts its next command, and it may expand `%VAR%`
 * and re-quote `"`. The kit's own arguments (ids, base64url) never hold these; a path might.
 */
const WINDOWS_TERMINAL_UNSAFE = /[;"%\p{Cc}]/u;
function command(command, args, folder, mode) {
    return { kind: 'command', request: { command, args, cwd: folder, mode } };
}
/**
 * The launcher call that opens the tab, each argument passed as it is, with no shell in between. Only
 * macOS Terminal takes shell text (`do script`), so there every argument is quoted, and the text goes
 * to AppleScript as a run argument, never inside the script.
 */
export function tabCommand(terminal, tab) {
    const { title, folder, argv } = tab;
    switch (terminal) {
        case 'tmux':
            // tmux 3.0 and later run a command given as several arguments without a shell.
            return command('tmux', ['new-window', '-c', folder, '-n', title, ...argv], folder, 'exit');
        case 'windows-terminal': {
            const unsafe = [title, folder, ...argv].find((arg) => WINDOWS_TERMINAL_UNSAFE.test(arg));
            if (unsafe !== undefined) {
                return { kind: 'unusable', why: `Windows Terminal would misread ${JSON.stringify(unsafe)} (it holds ; " % or a control character)` };
            }
            return command('wt.exe', ['-w', '0', 'new-tab', '--title', title, '-d', folder, '--', ...argv], folder, 'exit');
        }
        case 'macos-terminal':
            return command('osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', shellCommand('darwin', folder, argv)], folder, 'exit');
        case 'gnome-terminal':
            return command('gnome-terminal', ['--tab', `--working-directory=${folder}`, '--', ...argv], folder, 'exit');
        case 'konsole':
            return command('konsole', ['--new-tab', '--workdir', folder, '-e', ...argv], folder, 'spawn');
        case 'x-terminal-emulator':
            return command('x-terminal-emulator', ['-T', title, '-e', ...argv], folder, 'spawn');
    }
}
/** The terminals `auto` tries, in order: tmux inside tmux, then the platform's own. */
export function autoTerminals(env, platform) {
    const inTmux = (env['TMUX'] ?? '') === '' ? [] : ['tmux'];
    switch (platform) {
        case 'win32':
            return [...inTmux, 'windows-terminal'];
        case 'darwin':
            return [...inTmux, 'macos-terminal'];
        default:
            return [...inTmux, 'gnome-terminal', 'konsole', 'x-terminal-emulator'];
    }
}
