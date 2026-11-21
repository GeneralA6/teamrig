import type { DocumentName } from './envelope.ts';
import { INTERFACE_VERSION } from './version.ts';

/** The events version 1 sends, a frame each. */
export const EVENTS = ['hello', 'changed'] as const;
export type EventName = (typeof EVENTS)[number];

/**
 * A document as a frame names it: which one, and the revision `read --unless` takes for it now. `null` when its
 * files could not be stamped, so a reader reads the document to get the problem lines.
 */
export interface DocumentRevision {
  readonly document: DocumentName;
  readonly revision: string | null;
}

/**
 * One line of the event stream. It names documents and revisions and nothing else: no title, no line, no path, so
 * no text from outside the team ever rides a frame. A reader ignores an event or a field it does not know.
 */
export interface EventFrame {
  readonly interface: string;
  readonly event: EventName;
  readonly documents: readonly DocumentRevision[];
}

/** The first frame: every followed document with its revision now. */
export function helloFrame(documents: readonly DocumentRevision[]): EventFrame {
  return { interface: INTERFACE_VERSION, event: 'hello', documents };
}

/**
 * The documents of `now` whose revision is not the one `before` holds, in `now`'s order: what a `changed` frame
 * names. A document `before` does not hold counts as moved.
 */
export function movedDocuments(before: readonly DocumentRevision[], now: readonly DocumentRevision[]): readonly DocumentRevision[] {
  const held = new Map(before.map((entry) => [entry.document, entry.revision]));
  return now.filter((entry) => !held.has(entry.document) || held.get(entry.document) !== entry.revision);
}

/** The frame for the documents that moved, or none when nothing did: an empty frame is never sent. */
export function changedFrame(moved: readonly DocumentRevision[]): EventFrame | undefined {
  return moved.length === 0 ? undefined : { interface: INTERFACE_VERSION, event: 'changed', documents: moved };
}
