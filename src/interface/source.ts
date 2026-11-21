import type { ConnectorName } from './connector.ts';
import type { ServedText } from './text.ts';

/** Who a task's ask came from: the human owner, a session, or a tracker's import. */
export type SourceKind = 'owner' | 'session' | 'connector';

/** A task's source as data, so a reader needs neither the owner's marker nor a tracker's source text to tell them apart. */
export interface ServedSource {
  readonly kind: SourceKind;
  /** The source as the register holds it: the owner's marker, a session's id (`<team>/<id>` from another team), a connector's id. */
  readonly id: string;
  /** What a person calls it; the id itself for a session the team no longer lists. A name a person typed, so it is scanned. */
  readonly name: string;
}

/** What a source is read against. */
export interface SourceNames {
  /** The text that marks the human owner as a task's source (`register.ownerSource`). */
  readonly owner: string;
  readonly connectors: readonly ConnectorName[];
  /** A session's current name, or undefined for an id the team does not list. */
  nameOf(session: string): string | undefined;
}

/**
 * A task's source. The owner's marker is the team's own word, so it is read first; a source that is neither the
 * marker nor a connector's is a session's, as the register only ever takes those three, and it stays one after the
 * session has left the team. Its name is served as a text of record `record` (the task's id).
 */
export function sourceOf(served: ServedText, record: string, source: string, names: SourceNames): ServedSource {
  const named = (kind: SourceKind, id: string, name: string): ServedSource => ({ kind, id, name: served.plain(record, 'source.name', name) });
  if (source === names.owner) {
    return named('owner', source, source);
  }
  const connector = names.connectors.find((candidate) => candidate.id === source);
  if (connector !== undefined) {
    return named('connector', connector.id, connector.name);
  }
  return named('session', source, names.nameOf(source) ?? source);
}
