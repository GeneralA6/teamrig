import { stringField } from '../core/guards.ts';
import { ID_PATTERN, NAME_PATTERN } from '../core/ids.ts';
import { parseJsonl, type JsonlRecord } from '../core/jsonl.ts';

export const RENAME_VERSION = 1;

/**
 * One rename: session `id`, called `from`, is now called `to`. Records are only ever appended and
 * nothing is moved, since every file and record is keyed by the id; each name a session has had
 * stays on file and keeps finding it. `by` is the session that recorded it: the session itself,
 * when its hook saw its new Claude Code name, or the lead.
 */
export interface Rename {
  readonly v: number;
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly by: string;
}

export type RenameParse =
  | { readonly kind: 'rename'; readonly rename: Rename }
  /** Written by a newer release: skipped on read, and it blocks every write. */
  | { readonly kind: 'newer' }
  | { readonly kind: 'unreadable' };

export function parseRename(line: JsonlRecord): RenameParse {
  if (line.version > RENAME_VERSION) {
    return { kind: 'newer' };
  }
  const { record } = line;
  const id = stringField(record, 'id');
  const from = stringField(record, 'from');
  const to = stringField(record, 'to');
  const at = stringField(record, 'at');
  const by = stringField(record, 'by');
  if (
    id === undefined ||
    !ID_PATTERN.test(id) ||
    from === undefined ||
    !NAME_PATTERN.test(from) ||
    to === undefined ||
    !NAME_PATTERN.test(to) ||
    from === to ||
    at === undefined ||
    Number.isNaN(Date.parse(at)) ||
    by === undefined ||
    !ID_PATTERN.test(by)
  ) {
    return { kind: 'unreadable' };
  }
  return { kind: 'rename', rename: { v: line.version, id, from, to, at, by } };
}

export interface RenameLogRead {
  /** In file order, oldest first. */
  readonly renames: readonly Rename[];
  /** Damaged or foreign lines: skipped, never fatal. */
  readonly unreadable: number;
  /** Lines in a newer format: skipped on read, and they block every write. */
  readonly newer: number;
}

/** The renames in the text of a rename log (`renames.jsonl`), counting the lines it skips. */
export function readRenames(text: string): RenameLogRead {
  const parse = parseJsonl(text);
  const renames: Rename[] = [];
  let unreadable = parse.unreadable;
  let newer = 0;
  for (const line of parse.records) {
    const result = parseRename(line);
    if (result.kind === 'rename') {
      renames.push(result.rename);
    } else if (result.kind === 'newer') {
      newer += 1;
    } else {
      unreadable += 1;
    }
  }
  return { renames, unreadable, newer };
}
