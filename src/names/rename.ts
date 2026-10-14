import { stringField } from '../core/guards.ts';
import { ID_PATTERN, NAME_PATTERN } from '../core/ids.ts';
import type { JsonlRecord } from '../core/jsonl.ts';

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
