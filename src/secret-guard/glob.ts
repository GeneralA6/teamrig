/**
 * Globs as the secret guard reads them, compiled to regular expressions over a normalised path (forward slashes):
 * `**` spans folders (`**\/` also none), `*` and `?` stay inside one name, `[...]` is one character of a set, read as
 * bash reads it: a reversed range fits nothing, the members around it still do, and a set left empty is literal text.
 */

export interface GlobOptions {
  /** True on hosts whose file names ignore case (Windows, macOS). */
  readonly ignoreCase: boolean;
  /** False for a bash word, whose `*`, `?` and `[...]` never match the leading dot of a name. */
  readonly dotfiles: boolean;
}

/** A `[...]` set in a word, its inside captured. */
const SET = /\[([^\]/]+)\]/g;

/** A character a regular expression's set reads as syntax. */
const SET_SYNTAX = /[\\\]^-]/;

/** A `{...}` group of a glob: where it opens and closes, and the alternatives it holds, split at its own commas. */
interface BraceGroup {
  readonly open: number;
  readonly close: number;
  readonly choices: readonly string[];
}

/**
 * The globs a glob with `{a,b}` alternatives stands for, as ripgrep reads them: `*.{ts,pem}` gives `*.ts` and
 * `*.pem`, and a group inside an alternative is spelled out too. A brace inside a `[...]` set, or one that never
 * closes, is a plain character. Undefined past `limit` globs, so the caller can count such a glob as naming anything.
 */
export function braceAlternatives(glob: string, limit: number): string[] | undefined {
  const spelled: string[] = [];
  let pending = [glob];
  while (pending.length > 0) {
    const next: string[] = [];
    for (const item of pending) {
      const group = firstGroup(item);
      // Counted before the spread: past about 120,000 arguments a spread throws instead of reaching the limit.
      if (spelled.length + next.length + (group?.choices.length ?? 1) > limit) {
        return undefined;
      }
      if (group === undefined) {
        spelled.push(item);
      } else {
        next.push(...group.choices.map((choice) => `${item.slice(0, group.open)}${choice}${item.slice(group.close + 1)}`));
      }
    }
    pending = next;
  }
  return spelled;
}

/** The first `{...}` group of `glob` that closes, outside any `[...]` set. */
function firstGroup(glob: string): BraceGroup | undefined {
  for (let open = nextBrace(glob, 0); open !== -1; open = nextBrace(glob, open + 1)) {
    const group = groupAt(glob, open);
    if (group !== undefined) {
      return group;
    }
  }
  return undefined;
}

/** The index of the first `{` at or after `from` outside a `[...]` set, or -1. */
function nextBrace(glob: string, from: number): number {
  let index = from;
  while (index < glob.length) {
    const set = setEnd(glob, index);
    if (set !== undefined) {
      index = set;
    } else if (glob[index] === '{') {
      return index;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** The group that opens at `open`, its inner groups left in its choices; undefined when it never closes. */
function groupAt(glob: string, open: number): BraceGroup | undefined {
  const choices: string[] = [];
  let depth = 0;
  let start = open + 1;
  let index = open + 1;
  while (index < glob.length) {
    const set = setEnd(glob, index);
    if (set !== undefined) {
      index = set;
      continue;
    }
    const char = glob[index];
    if (char === '}' && depth === 0) {
      choices.push(glob.slice(start, index));
      return { open, close: index, choices };
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      choices.push(glob.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  return undefined;
}

/** The index after a `[...]` set that starts at `index`, read as {@link globPart} reads one; undefined for no set. */
function setEnd(glob: string, index: number): number | undefined {
  if (glob[index] !== '[') {
    return undefined;
  }
  const close = glob.indexOf(']', index + 2);
  return close !== -1 && !glob.slice(index + 1, close).includes('/') ? close + 1 : undefined;
}

/**
 * True when `text` holds a wildcard a shell or the guard expands: `*`, `?` or a `[...]` set. One set no character fits
 * (`[z-a]`) means none: the word can match no file, so bash keeps all of it as typed, and it names that literal path.
 */
export function hasWildcard(text: string): boolean {
  const sets = [...text.matchAll(SET)].map(([, body = '']) => setExpression(body));
  return !sets.includes(undefined) && (sets.length > 0 || /[*?]/.test(text));
}

/** `glob` as a regular expression that matches a whole path. */
export function globRegExp(glob: string, options: GlobOptions): RegExp {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const nameStart = index === 0 || glob[index - 1] === '/';
    const noDot = !options.dotfiles && nameStart ? '(?!\\.)' : '';
    if (glob.startsWith('**/', index) && nameStart) {
      source += options.dotfiles ? '(?:.*/)?' : '(?:(?!\\.)[^/]*/)*';
      index += 3;
    } else if (glob.startsWith('**', index) && nameStart && index + 2 === glob.length) {
      source += options.dotfiles ? '.*' : '(?:(?!\\.)[^/]*(?:/|$))*';
      index += 2;
    } else if (glob.startsWith('/**', index) && index + 3 === glob.length) {
      source += options.dotfiles ? '(?:/.*)?' : '(?:/(?!\\.)[^/]*)*';
      index += 3;
    } else {
      const [part, next] = globPart(glob, index);
      source += (part.startsWith('[') || part.startsWith('(?:[^/]') ? noDot : '') + part;
      index = next;
    }
  }
  return new RegExp(`^${source}$`, options.ignoreCase ? 'i' : '');
}

/** The expression for one glob character, or a `[...]` set, at `index`, and the index after it. */
function globPart(glob: string, index: number): [string, number] {
  const char = glob[index] ?? '';
  if (char === '*') {
    let end = index;
    while (glob[end] === '*') {
      end += 1;
    }
    return ['(?:[^/]*)', end];
  }
  if (char === '?') {
    return ['(?:[^/])', index + 1];
  }
  if (char === '[') {
    const close = glob.indexOf(']', index + 2);
    const body = close === -1 ? '' : glob.slice(index + 1, close);
    const set = close === -1 || body.includes('/') ? undefined : setExpression(body);
    if (set !== undefined) {
      return [set, close + 1];
    }
  }
  return [char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), index + 1];
}

/** The expression for the `[...]` set with inside `body`, or undefined when no character fits it. */
function setExpression(body: string): string | undefined {
  const negated = body.startsWith('!') || body.startsWith('^');
  const members = setMembers(negated ? body.slice(1) : body);
  if (negated) {
    return `[^/${members}]`;
  }
  return members === '' ? undefined : `[${members}]`;
}

/**
 * The members of a set, for a regular expression's set. A reversed range (`z-a`) stays out: `new RegExp` throws on one,
 * and reading the whole set as literal text instead would let `.en[z-av]` reach `.env` unseen, as bash still fits the
 * `v`. A `-` left over is escaped, so that a dropped range cannot join the members on either side of it into a new one.
 */
function setMembers(body: string): string {
  const member = (char: string): string => char.replace(SET_SYNTAX, '\\$&');
  let members = '';
  let index = 0;
  while (index < body.length) {
    const first = body.charAt(index);
    const last = body.charAt(index + 2);
    if (body.charAt(index + 1) === '-' && last !== '') {
      members += first <= last ? `${member(first)}-${member(last)}` : '';
      index += 3;
    } else {
      members += member(first);
      index += 1;
    }
  }
  return members;
}
