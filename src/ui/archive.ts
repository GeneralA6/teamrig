/**
 * The reader of the dedicated UI's archive (T4761): the one file a teamrig-pane release carries the UI's scripts in,
 * a JSON document `{ format, version, interface, entry, files: [{ path, text }] }`. `teamrig ui` fetches it over the network, so
 * nothing in it is trusted. Its bytes are held to the sha256 this teamrig release pins before a single one is parsed,
 * and what parses is then held to its shape: a path that could leave the folder the files are written into, two
 * paths one disk would write as one file, or an entry that is not among the files refuses the whole archive. Nothing
 * here touches a disk or the network.
 */
import { createHash } from 'node:crypto';
import { isRecord } from '../core/guards.ts';
import { parseInterfaceVersion, type InterfaceVersion } from '../interface/version.ts';

/** The archive shape read here; an archive of another one is refused. */
export const ARCHIVE_FORMAT = 1;

/** The name a teamrig-pane release carries the archive under. */
export const ARCHIVE_NAME = 'teamrig-ui.json';

export interface UiFile {
  /** From the folder the archive is written into, `/`-separated. */
  readonly path: string;
  readonly text: string;
}

export interface UiArchive {
  /** The teamrig-pane release the scripts come from; also the name of the folder they are written into. */
  readonly version: string;
  /**
   * The version of teamrig's public interface the UI was written against, which is its range: that major, at that
   * minor or a later one. No archive was released before this field, so format 1 requires it.
   */
  readonly interface: InterfaceVersion;
  /** The script `node` is started on, one of `files`. */
  readonly entry: string;
  readonly files: readonly UiFile[];
}

export type ArchiveRead = { readonly ok: true; readonly archive: UiArchive } | { readonly ok: false; readonly reason: string };

/** One folder or file name: letters, digits, `_`, `-` and `.`, never starting with a dot, so never `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Names Windows gives a device whatever follows the first dot: writing `nul.js` there writes no file. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const SHA256 = /^[0-9a-f]{64}$/;

function isSegment(name: string): boolean {
  // Windows drops a trailing dot, so `a.` and `a` would be one file there.
  return SEGMENT.test(name) && !name.endsWith('.') && !DEVICE.test(name.split('.')[0] ?? '');
}

/** Whether `path` stays under the folder it is written into on every OS: relative, `/`-separated, each name plain. */
export function isArchivePath(path: string): boolean {
  return path.length > 0 && path.split('/').every(isSegment);
}

/** The sha256 of `bytes`, in lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function refused(reason: string): ArchiveRead {
  return { ok: false, reason };
}

/** `bytes` as UTF-8 text, undefined when they are not UTF-8. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function fileOf(value: unknown): UiFile | undefined {
  if (!isRecord(value)) return undefined;
  const { path, text } = value;
  return typeof path === 'string' && typeof text === 'string' ? { path, text } : undefined;
}

/**
 * Why these paths cannot all be written under one folder, undefined when they can. Paths are compared without case,
 * as Windows and macOS disks hold them: two that differ only by case are one file there, and a path that is both a
 * file and a folder of another cannot be written anywhere.
 */
function clashOf(paths: readonly string[]): string | undefined {
  const files = new Set<string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (files.has(key)) return `two files at ${path}`;
    files.add(key);
  }
  for (const path of paths) {
    const names = path.toLowerCase().split('/');
    for (let depth = 1; depth < names.length; depth += 1) {
      if (files.has(names.slice(0, depth).join('/'))) return `${path} is under a path that is also a file`;
    }
  }
  return undefined;
}

/**
 * The archive in `bytes`, once their sha256 equals `pin` (64 hex digits). The hash is taken first: bytes that are not
 * the pinned ones are never decoded or parsed. Every refusal says why in words fit for the person.
 */
export function readArchive(bytes: Uint8Array, pin: string): ArchiveRead {
  const wanted = pin.toLowerCase();
  if (!SHA256.test(wanted)) return refused('the pinned sha256 is not 64 hex digits');
  const found = sha256Hex(bytes);
  if (found !== wanted) return refused(`its sha256 is ${found}, not the pinned ${wanted}`);

  const text = textOf(bytes);
  if (text === undefined) return refused('it is not UTF-8 text');
  const document = parsed(text);
  if (!isRecord(document)) return refused('it is not a JSON object');
  const { format, version, interface: speaks, entry, files } = document;
  if (format !== ARCHIVE_FORMAT) return refused(`its format is ${JSON.stringify(format)}, and this teamrig reads format ${ARCHIVE_FORMAT}`);
  if (typeof version !== 'string' || !isSegment(version)) return refused('its version is not a plain name');
  const range = typeof speaks === 'string' ? parseInterfaceVersion(speaks) : undefined;
  if (speaks === undefined) return refused('it names no interface version');
  if (range === undefined) return refused(`its interface ${JSON.stringify(speaks)} is no <major>.<minor> version`);
  if (typeof entry !== 'string') return refused('it names no entry');
  if (!Array.isArray(files)) return refused('it holds no list of files');

  const read: UiFile[] = [];
  for (const value of files) {
    const file = fileOf(value);
    if (file === undefined) return refused('one of its files lacks a path or a text');
    if (!isArchivePath(file.path)) return refused(`a file's path could leave the folder it is written into: ${JSON.stringify(file.path)}`);
    read.push(file);
  }
  const clash = clashOf(read.map((file) => file.path));
  if (clash !== undefined) return refused(`its files cannot all be written: ${clash}`);
  if (!read.some((file) => file.path === entry)) return refused(`its entry ${JSON.stringify(entry)} is not among its files`);
  return { ok: true, archive: { version, interface: range, entry, files: read } };
}
