/**
 * The texts bash may run for one Bash tool call. On Windows, Claude Code hands the command to Git Bash through a
 * Windows command line, and each run of backslashes not followed by a double quote reaches bash halved, rounded up,
 * even inside single quotes; a run before a double quote is kept. So a guard that reads only the command as written
 * misses what bash runs: `ls a\\\; rm -f x` reads as one ls, while bash gets `ls a\\; rm -f x` and runs the rm.
 * A guard weighs every reading and takes the stricter verdict, so it stays right if Claude Code later passes the text
 * through unchanged.
 */
const BACKSLASH_RUN = /\\+/g;
/** The text bash receives for a Bash tool command on Windows: each backslash run not followed by `"` halved, rounded up. */
export function halvedBackslashRuns(command) {
    return command.replace(BACKSLASH_RUN, (run, at) => command[at + run.length] === '"' ? run : '\\'.repeat(Math.ceil(run.length / 2)));
}
/** The command as written and, on Windows when it differs, the halved text bash receives: a guard weighs each. */
export function bashToolReadings(command, platform) {
    if (platform !== 'win32') {
        return [command];
    }
    const halved = halvedBackslashRuns(command);
    return halved === command ? [command] : [command, halved];
}
/**
 * The texts a shell tool call may run: a Bash call's {@link bashToolReadings}; any other tool's command as written,
 * since only the Bash tool's line passes through the Windows command line that halves backslash runs.
 */
export function toolCommandReadings(tool, command, platform) {
    return tool === 'Bash' ? bashToolReadings(command, platform) : [command];
}
