/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 2;
export const COMMIT_GATES = ['off', 'warn', 'refuse'];
export function isCommitGate(value) {
    return COMMIT_GATES.some((gate) => gate === value);
}
/**
 * Where `teamrig open` opens a session's tab: `auto` picks tmux inside tmux, else the platform's
 * terminal; `print` opens nothing and prints the command to run.
 */
export const TERMINALS = ['auto', 'tmux', 'windows-terminal', 'macos-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator', 'print'];
export function isTerminalChoice(value) {
    return TERMINALS.some((terminal) => terminal === value);
}
