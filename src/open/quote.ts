/**
 * Quoting for the one place a command becomes shell text: the command `teamrig open` prints, or hands
 * to macOS Terminal, when it cannot start the tab with an argument list. Every argument is quoted, so
 * nothing in it (quotes, `;`, `&`, `|`, backticks, `$()`, newlines, `%VAR%`) is ever read as syntax.
 */

/** One argument for a POSIX shell: single quotes, inside which only `'` itself needs care. */
export function posixQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * One argument for PowerShell: a single-quoted string, which expands nothing. PowerShell also ends one
 * at the typographic single quotes, so every one of those is doubled as well.
 */
export function powershellQuote(arg: string): string {
  return `'${arg.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/**
 * One argument of a Windows command line, by the rules the C runtime (and node, through libuv) split one with: an
 * argument with no space, tab, newline or quote goes as is; any other is double-quoted, a `"` in it becomes `\"`, and
 * the backslashes before a quote or the closing quote are doubled, while every other backslash stays single. Only the
 * program reads this, no shell: never pass the result through cmd.exe, whose `%` and `^` it leaves alone.
 */
export function windowsArgQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) {
    return arg;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** A whole Windows command line: each argument quoted by `windowsArgQuote`, joined by spaces. */
export function windowsCommandLine(argv: readonly string[]): string {
  return argv.map(windowsArgQuote).join(' ');
}

/** A command to run in `folder`, for PowerShell on Windows and a POSIX shell elsewhere. */
export function shellCommand(platform: NodeJS.Platform, folder: string, argv: readonly string[]): string {
  if (platform === 'win32') {
    return `Set-Location -LiteralPath ${powershellQuote(folder)}; & ${argv.map(powershellQuote).join(' ')}`;
  }
  return `cd ${posixQuote(folder)} && ${argv.map(posixQuote).join(' ')}`;
}
