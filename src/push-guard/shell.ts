/** Which shell wrote a command line; it decides the escape character (`\` or the backtick). */
export type ShellDialect = 'bash' | 'powershell';

/** A PowerShell here-string: `@'` or `@"` ending its line, through the matching `'@` or `"@` line. */
const HERE_STRING = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g;
/** A bash heredoc start: `<<EOF`, `<<'EOF'`, `<<-EOF`, but not the `<<<` here-string. */
const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g;

/**
 * Removes the bodies of bash heredocs and PowerShell here-strings, which are data, not
 * commands. A heredoc whose terminator never appears is kept, so a stray `<<` cannot hide a
 * real command from the guard.
 */
export function stripHeredocs(command: string): string {
  const lines = command.replace(HERE_STRING, "''").split('\n');
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    kept.push(line);
    index += 1;
    for (const match of line.matchAll(HEREDOC_START)) {
      const terminator = match[2];
      const end = lines.findIndex((candidate, at) => at >= index && candidate.replace(/\r$/, '').trim() === terminator);
      if (end === -1) {
        break;
      }
      index = end + 1;
    }
  }
  return kept.join('\n');
}

/**
 * Splits a command line into simple commands (lists of words) the way a shell would: quotes
 * group words, unquoted `; & | ( )`, the bash backtick and newlines separate commands, `#` at a
 * word start begins a comment, and a redirection (`> file`, `2>&1`) is dropped with its target.
 */
export function splitCommands(command: string, dialect: ShellDialect): string[][] {
  const escape = dialect === 'powershell' ? '`' : '\\';
  const at = (index: number): string => command.charAt(index);
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let skipNextWord = false;

  const endWord = (): void => {
    if (inWord) {
      if (skipNextWord) {
        skipNextWord = false;
      } else {
        words.push(word);
      }
    }
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    skipNextWord = false;
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = at(index);
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const stop = close === -1 ? command.length : close;
      word += command.slice(index + 1, stop);
      inWord = true;
      index = stop;
    } else if (char === '"') {
      inWord = true;
      for (index += 1; index < command.length && at(index) !== '"'; index += 1) {
        const escapes = dialect === 'powershell' ? at(index) === '`' : at(index) === '\\' && /["\\$`\n]/.test(at(index + 1));
        if (escapes) {
          index += 1;
        }
        word += at(index);
      }
    } else if (char === escape) {
      index += 1;
      if (at(index) !== '\n') {
        word += at(index);
      }
      inWord = true;
    } else if (char === '#' && !inWord) {
      while (index + 1 < command.length && at(index + 1) !== '\n') {
        index += 1;
      }
    } else if (char === '<' || char === '>') {
      // A file-descriptor number before the operator (`2>`) belongs to the redirection.
      if (/^\d*$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      while (/[<>&|-]/.test(at(index + 1))) {
        index += 1;
      }
      if (at(index) === '&' && /\d/.test(at(index + 1))) {
        while (/\d/.test(at(index + 1))) {
          index += 1;
        }
      } else {
        skipNextWord = true;
      }
    } else if (/[;&|()`\n]/.test(char)) {
      endCommand();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}
