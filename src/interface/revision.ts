import type { DocumentName } from './envelope.ts';
import { INTERFACE_VERSION } from './version.ts';

/**
 * What a document's revision is made of: everything that decides its answer's bytes, short of reading the stores.
 * Two answers built from equal parts are equal, so a reader that hands a revision back (`--unless`) is answered
 * `unchanged` without the stores being read at all.
 */
export interface RevisionParts {
  readonly document: DocumentName;
  /** What the reader asked for that shapes the answer, as name and value; null for one it left out. */
  readonly args: readonly (readonly [string, string | null])[];
  /** The stamp of each file the document reads, in a fixed order; null for a file that is not there. */
  readonly stamps: readonly (string | null)[];
}

/**
 * The one text a document's parts spell, which the command hashes into the revision. The interface version is part
 * of it, so a teamrig serving a newer minor never answers `unchanged` to a revision an older one handed out: the
 * same stores may now hold a field more. JSON keeps the parts apart, so no value can be read as two.
 */
export function revisionText(parts: RevisionParts): string {
  return JSON.stringify([INTERFACE_VERSION, parts.document, parts.args, parts.stamps]);
}
