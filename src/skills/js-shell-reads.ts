/**
 * The `${NAME}` reads a JavaScript or TypeScript script hands a shell. In a template literal `${NAME}` interpolates
 * a JS value, so only its escaped `\${NAME}` reaches the shell; in a '...' or "..." string `${NAME}` is plain text
 * that the shell expands. A light scanner, not a parser: it skips comments, reads a regex literal as code, and ends
 * a quoted string at its line's end.
 */
export function shellBraceReads(text: string): string[] {
  const names: string[] = [];
  const read = /\$\{([A-Z][A-Z0-9_]*)/y;
  const readAt = (at: number): void => {
    read.lastIndex = at;
    const name = read.exec(text)?.[1];
    if (name !== undefined) names.push(name);
  };
  /** The templates and `${` expressions open here, innermost last, with each `{` opened inside an expression. */
  const open: ('`' | '{')[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (open.at(-1) === '`') {
      at = templateStep(text, at, open, readAt);
    } else if (char === "'" || char === '"') {
      at = quotedEnd(text, at, readAt);
    } else if (text.startsWith('//', at)) {
      at = skipPast(text, '\n', at + 2);
    } else if (text.startsWith('/*', at)) {
      at = skipPast(text, '*/', at + 2);
    } else {
      if (char === '`' || (char === '{' && open.length > 0)) open.push(char);
      else if (char === '}' && open.at(-1) === '{') open.pop();
      at += 1;
    }
  }
  return names;
}

/** One step inside a template literal: an escape (where `\${NAME}` is a shell read), its end, or a `${` expression. */
function templateStep(text: string, at: number, open: ('`' | '{')[], readAt: (at: number) => void): number {
  const char = text.charAt(at);
  if (char === '\\') {
    readAt(at + 1);
    return at + 2;
  }
  if (char === '`') {
    open.pop();
  } else if (text.startsWith('${', at)) {
    open.push('{');
    return at + 2;
  }
  return at + 1;
}

/** Past a '...' or "..." string that starts at `start`, reading each `${NAME}` in it; it ends at its quote or line end. */
function quotedEnd(text: string, start: number, readAt: (at: number) => void): number {
  const quote = text.charAt(start);
  let at = start + 1;
  while (at < text.length && text.charAt(at) !== quote && text.charAt(at) !== '\n') {
    if (text.charAt(at) === '\\') {
      at += 2;
    } else {
      readAt(at);
      at += 1;
    }
  }
  return at + 1;
}

/** Past the next `mark` from `from`, or the text's end when none follows. */
function skipPast(text: string, mark: string, from: number): number {
  const end = text.indexOf(mark, from);
  return end === -1 ? text.length : end + mark.length;
}
