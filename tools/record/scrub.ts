import { PRIVATE_SHAPES } from '../../src/core/private-shapes.ts';
import { isRecord } from '../lib/guards.ts';

/** The private places and names of the machine a recording was made on. */
export interface ScrubRoots {
  /** The folder the recorded session ran in. */
  readonly cwd: string;
  /** The machine's temp folder, which holds the recording's throwaway files. */
  readonly temp: string;
  /** The user's home folder. */
  readonly home: string;
  /** The user's login name. */
  readonly user: string;
  /** The machine's host name. */
  readonly host: string;
}

/** What stands for each root in a scrubbed recording; a reader puts its own folders in their place. */
export const PLACEHOLDERS = { cwd: '{{cwd}}', cwdSlug: '{{cwd-slug}}', temp: '{{temp}}', home: '{{home}}' } as const;
/** What stands for the user's and the machine's name wherever one is left outside a path. */
const USER_NAME = 'user';
const HOST_NAME = 'host';
/** What stands for every e-mail address: a documentation address, which the repository scrub lets through. */
const EMAIL_ADDRESS = 'user@example.com';
/** The repository scrub's own e-mail shape, so what it would refuse is what gets replaced. */
const EMAIL_PATTERNS: readonly RegExp[] = PRIVATE_SHAPES.filter((shape) => shape.id === 'email').map((shape) => shape.pattern);
/** What stands for a signed blob, such as a thinking block's signature. */
const SIGNATURE = 'recorded-signature';
/** Keys whose string value is a signed blob no reader parses. */
const SIGNED_KEYS: ReadonlySet<string> = new Set(['signature']);
/** A name shorter than this is too likely a plain word's part to replace everywhere. */
const MIN_NAME_LENGTH = 3;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** An id Anthropic's API gives a message, a request or a tool call. */
const API_ID = /\b(msg|req|toolu|srvtoolu)_[A-Za-z0-9]{6,}\b/g;
const SEPARATOR = String.raw`(?:\\{1,2}|/)`;
/** The rest of a path after a root: its segments, each led by a separator. */
const TAIL = new RegExp(String.raw`^(?:${SEPARATOR}[^\\/\s"'\`<>|:*?()[\]{},;]+)*`);
const SEPARATORS = /\\{1,2}/g;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The folder name Claude Code keeps a project's transcripts under: the session folder, each character that is no letter or digit as `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Matches `root` however a recording spells it: with `\`, `/` or JSON-escaped `\\` between its segments, in any
 * letter case, and with a Windows drive as `C:` or as Git Bash's `/c`. It never starts inside a longer path, so the
 * root `/tmp` is not found in `/var/tmp`.
 */
function rootPattern(root: string): RegExp {
  const [first = '', ...rest] = root.split(/[\\/]+/).filter((segment, index) => segment !== '' || index === 0);
  const drive = /^([A-Za-z]):$/.exec(first)?.[1];
  const head = drive === undefined ? escaped(first) : `(?:${drive}:|/${drive})`;
  return new RegExp(`(?<![A-Za-z0-9._~-])${head}${rest.map((segment) => `${SEPARATOR}${escaped(segment)}`).join('')}`, 'gi');
}

function namePattern(name: string): RegExp | undefined {
  return name.length < MIN_NAME_LENGTH ? undefined : new RegExp(String.raw`(?<![A-Za-z0-9])${escaped(name)}(?![A-Za-z0-9])`, 'gi');
}

/**
 * Takes what is private to one machine and one account out of a recording, the same way everywhere in it, so a
 * session id, a tool call id or a file's path still joins across the hook inputs, the transcripts and the status line:
 * - a path under the session folder, the temp folder or the home folder starts with its placeholder, and the rest of
 *   it uses `/`;
 * - Claude Code's project folder name for the session folder is its placeholder;
 * - each UUID and each API id (message, request, tool call) is numbered by first appearance;
 * - every e-mail address is one documentation address;
 * - the user's and the machine's name are `user` and `host`; a signature is a fixed word.
 */
export class Scrubber {
  private readonly roots: readonly (readonly [RegExp, string])[];
  private readonly slug: RegExp;
  private readonly names: readonly (readonly [RegExp, string])[];
  private readonly uuids = new Map<string, string>();
  private readonly apiIds = new Map<string, string>();

  constructor(roots: ScrubRoots) {
    // Longest first: the session folder lies inside the temp folder, which may lie inside the home folder.
    const pairs: readonly (readonly [string, string])[] = [
      [roots.cwd, PLACEHOLDERS.cwd],
      [roots.temp, PLACEHOLDERS.temp],
      [roots.home, PLACEHOLDERS.home],
    ];
    this.roots = pairs
      .filter(([root]) => root !== '')
      .sort(([a], [b]) => b.length - a.length)
      .map(([root, placeholder]) => [rootPattern(root), placeholder]);
    this.slug = new RegExp(escaped(projectSlug(roots.cwd)), 'g');
    const names: readonly (readonly [string, string])[] = [
      [roots.user, USER_NAME],
      [roots.host, HOST_NAME],
    ];
    this.names = names.flatMap(([name, stand]) => {
      const pattern = namePattern(name);
      return pattern === undefined ? [] : [[pattern, stand]];
    });
  }

  /** `text` with every private part replaced. */
  text(text: string): string {
    let result = text;
    for (const [pattern, placeholder] of this.roots) {
      result = rehomed(result, pattern, placeholder);
    }
    // After the roots: a path's tail ends at a placeholder, so the project folder inside one is named last.
    result = result.replace(this.slug, PLACEHOLDERS.cwdSlug);
    // Before the names: an address that holds the user's name goes whole.
    for (const pattern of EMAIL_PATTERNS) {
      result = result.replace(pattern, EMAIL_ADDRESS);
    }
    for (const [pattern, stand] of this.names) {
      result = result.replace(pattern, stand);
    }
    return result
      .replace(UUID, (id) => numbered(this.uuids, id.toLowerCase(), (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`))
      .replace(API_ID, (id, prefix: string) => numbered(this.apiIds, id, (n) => `${prefix}_recorded${String(n).padStart(4, '0')}`));
  }

  /** A JSON value with every string in it scrubbed, keys included. */
  value(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => this.value(item));
    }
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [this.text(key), SIGNED_KEYS.has(key) && typeof item === 'string' ? SIGNATURE : this.value(item)]),
    );
  }
}

/** The stand-in for `id`, numbered from 1 in order of first appearance. */
function numbered(seen: Map<string, string>, id: string, format: (n: number) => string): string {
  const known = seen.get(id);
  if (known !== undefined) {
    return known;
  }
  const stand = format(seen.size + 1);
  seen.set(id, stand);
  return stand;
}

/** `text` with each path under the root `pattern` matches starting with `placeholder`, the rest of the path using `/`. */
function rehomed(text: string, pattern: RegExp, placeholder: string): string {
  let result = '';
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    // A match inside the path just replaced is part of it; a longer name that only starts like the root
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
