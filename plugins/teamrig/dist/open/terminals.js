import { shellCommand } from "./quote.js";
/** The window of a team's own its tabs open in when `open.teamWindow` is on, apart from other teams' tabs (T1427). */
export function teamWindowOf(teamWindow, team) {
    return teamWindow ? `teamrig-${team}` : undefined;
}
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
    const { title, folder, argv, window, focus } = tab;
    switch (terminal) {
        case 'tmux':
            // tmux 3.0 and later run a command given as several arguments without a shell; -d leaves the current window selected.
            return command('tmux', ['new-window', ...(focus === 'keep' ? ['-d'] : []), '-c', folder, '-n', title, ...argv], folder, 'exit');
        case 'windows-terminal': {
            const unsafe = [title, folder, ...(window === undefined ? [] : [window]), ...argv].find((arg) => WINDOWS_TERMINAL_UNSAFE.test(arg));
            if (unsafe !== undefined) {
                return { kind: 'unusable', why: `Windows Terminal would misread ${JSON.stringify(unsafe)} (it holds ; " % or a control character)` };
            }
            // `-w 0` is the most recent window; a name is the window of that name, made when none is open.
            return command('wt.exe', ['-w', window ?? '0', 'new-tab', '--title', title, '-d', folder, '--', ...argv], folder, 'exit');
        }
        case 'macos-terminal':
            // Without `activate`, Terminal opens the window behind the app the owner is in.
            return command('osascript', [
                '-e',
                'on run argv',
                '-e',
                'tell application "Terminal"',
                ...(focus === 'take' ? ['-e', 'activate'] : []),
                '-e',
                'do script (item 1 of argv)',
                '-e',
                'end tell',
                '-e',
                'end run',
                shellCommand('darwin', folder, argv),
            ], folder, 'exit');
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
