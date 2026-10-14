/**
 * Quoting for the one place a command becomes shell text: the command `teamrig open` prints, or hands
 * to macOS Terminal, when it cannot start the tab with an argument list. Every argument is quoted, so
 * nothing in it (quotes, `;`, `&`, `|`, backticks, `$()`, newlines, `%VAR%`) is ever read as syntax.
 */
/** One argument for a POSIX shell: single quotes, inside which only `'` itself needs care. */
export function posixQuote(arg) {
    return `'${arg.replaceAll("'", "'\\''")}'`;
}
/**
 * One argument for PowerShell: a single-quoted string, which expands nothing. PowerShell also ends one
 * at the typographic single quotes, so every one of those is doubled as well.
 */
export function powershellQuote(arg) {
    return `'${arg.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}
/** A command to run in `folder`, for PowerShell on Windows and a POSIX shell elsewhere. */
export function shellCommand(platform, folder, argv) {
    if (platform === 'win32') {
        return `Set-Location -LiteralPath ${powershellQuote(folder)}; & ${argv.map(powershellQuote).join(' ')}`;
    }
    return `cd ${posixQuote(folder)} && ${argv.map(posixQuote).join(' ')}`;
}
