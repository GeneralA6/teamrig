import { PRIVATE_SHAPES } from '../../src/core/private-shapes.ts';
import { FolderNames, literalPattern, type RecordedFolders } from '../../src/testing/folder-names.ts';
import { isRecord } from '../lib/guards.ts';

/** The private places and names of the machine a recording was made on. */
export interface ScrubRoots extends RecordedFolders {
  /** The user's login name. */
  readonly user: string;
  /** The machine's host name. */
  readonly host: string;
}

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

function namePattern(name: string): RegExp | undefined {
  return name.length < MIN_NAME_LENGTH ? undefined : new RegExp(String.raw`(?<![A-Za-z0-9])${literalPattern(name)}(?![A-Za-z0-9])`, 'gi');
}

/**
 * Takes what is private to one machine and one account out of a recording, the same way everywhere in it, so a
 * session id, a tool call id or a file's path still joins across the hook inputs, the transcripts and the status line:
 * - a path under the session folder, the temp folder or the home folder starts with its placeholder, and the rest of
 *   it uses `/`, and Claude Code's project folder name for the session folder is its placeholder (`FolderNames`);
 * - each UUID and each API id (message, request, tool call) is numbered by first appearance;
 * - every e-mail address is one documentation address;
 * - the user's and the machine's name are `user` and `host`; a signature is a fixed word.
 */
export class Scrubber {
  private readonly folders: FolderNames;
  private readonly names: readonly (readonly [RegExp, string])[];
  private readonly uuids = new Map<string, string>();
  private readonly apiIds = new Map<string, string>();

  constructor(roots: ScrubRoots) {
    this.folders = new FolderNames(roots);
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
    let result = this.folders.named(text);
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
