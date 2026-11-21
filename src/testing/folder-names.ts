import { isRecord } from '../core/guards.ts';

/** The folders of one machine: the one a recording was made on, or the one that replays it. */
export interface RecordedFolders {
  /** The folder the recorded session ran in. */
  readonly cwd: string;
  /** The machine's temp folder, which holds the recording's throwaway files. */
  readonly temp: string;
  /** The user's home folder. */
  readonly home: string;
}

/** What stands for each folder in a scrubbed recording; a reader puts its own folders in their place. */
export const PLACEHOLDERS = { cwd: '{{cwd}}', cwdSlug: '{{cwd-slug}}', temp: '{{temp}}', home: '{{home}}' } as const;

const SEPARATOR = String.raw`(?:\\{1,2}|/)`;
/** The rest of a path after a folder: its segments, each led by a separator. */
const TAIL = new RegExp(String.raw`^(?:${SEPARATOR}[^\\/\s"'\`<>|:*?()[\]{},;]+)*`);
const SEPARATORS = /\\{1,2}/g;

/** `text` as a pattern that matches it literally. */
export function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The folder name Claude Code keeps a project's transcripts under: the session folder, each character that is no letter or digit as `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * A JSON value with `change` applied to every string in it, a record's keys included. A recording has its folders
 * named and filled this way, value by value: in raw JSON text a path's last segment would take the `\n` escape that
 * follows it for part of the path.
 */
export function withStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return change(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withStrings(item, change));
  }
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [change(key), withStrings(item, change)])) : value;
}

/**
 * Matches `folder` however a text spells it: with `\`, `/` or JSON-escaped `\\` between its segments, in any letter
 * case, and with a Windows drive as `C:` or as Git Bash's `/c`. It never starts inside a longer path, so the folder
 * `/tmp` is not found in `/var/tmp`.
 */
function folderPattern(folder: string): RegExp {
  const [first = '', ...rest] = folder.split(/[\\/]+/).filter((segment, index) => segment !== '' || index === 0);
  const drive = /^([A-Za-z]):$/.exec(first)?.[1];
  const head = drive === undefined ? literalPattern(first) : `(?:${drive}:|/${drive})`;
  return new RegExp(`(?<![A-Za-z0-9._~-])${head}${rest.map((segment) => `${SEPARATOR}${literalPattern(segment)}`).join('')}`, 'gi');
}

/** `text` with each path under the folder `pattern` matches starting with `placeholder`, the rest of the path using `/`. */
function rehomed(text: string, pattern: RegExp, placeholder: string): string {
  let result = '';
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    // A match inside the path just replaced is part of it; a longer name that only starts like the folder
    // (`/tmp/cwd-other`) is another folder.
    if (match.index < from || /[A-Za-z0-9_-]/.test(text.charAt(end))) {
      continue;
    }
    const tail = TAIL.exec(text.slice(end))?.[0] ?? '';
    result += `${text.slice(from, match.index)}${placeholder}${tail.replace(SEPARATORS, '/')}`;
    from = end + tail.length;
  }
  return result + text.slice(from);
}

/**
 * Trades one machine's folders for their placeholders and back, so a recording made on one machine reads the same on
 * every other: `named` is how a recording, or what a replay printed, loses its machine, and `filled` is how a reader
 * gives a recording its own folders. `others` adds folders a recording does not have, each by its placeholder, such as
 * a test harness's kit home. A folder given as `''` is one the machine does not have, and is left alone.
 */
export class FolderNames {
  private readonly patterns: readonly (readonly [RegExp, string])[];
  private readonly slug: RegExp | undefined;
  private readonly fills: readonly (readonly [string, string])[];

  constructor(folders: RecordedFolders, others: Readonly<Record<string, string>> = {}) {
    const pairs: readonly (readonly [string, string])[] = [
      [PLACEHOLDERS.cwd, folders.cwd],
      [PLACEHOLDERS.temp, folders.temp],
      [PLACEHOLDERS.home, folders.home],
      ...Object.entries(others),
    ];
    const held = pairs.filter(([, folder]) => folder !== '');
    // Longest first: the session folder may lie inside the temp folder, which may lie inside the home folder.
    this.patterns = [...held].sort(([, a], [, b]) => b.length - a.length).map(([placeholder, folder]) => [folderPattern(folder), placeholder]);
    const slug = folders.cwd === '' ? undefined : projectSlug(folders.cwd);
    this.slug = slug === undefined ? undefined : new RegExp(literalPattern(slug), 'g');
    this.fills = slug === undefined ? held : [[PLACEHOLDERS.cwdSlug, slug], ...held];
  }

  /**
   * `text` with each path under a folder starting with that folder's placeholder, the rest of the path using `/`, and
   * with Claude Code's project folder name for the session folder as its placeholder.
   */
  named(text: string): string {
    let result = text;
    for (const [pattern, placeholder] of this.patterns) {
      result = rehomed(result, pattern, placeholder);
    }
    // After the folders: a path's tail ends at a placeholder, so the project folder inside one is named last.
    return this.slug === undefined ? result : result.replace(this.slug, PLACEHOLDERS.cwdSlug);
  }

  /** `text` with each placeholder replaced by its folder; the rest of a recorded path keeps its `/`. */
  filled(text: string): string {
    return this.fills.reduce((result, [placeholder, folder]) => result.replaceAll(placeholder, () => folder), text);
  }
}
