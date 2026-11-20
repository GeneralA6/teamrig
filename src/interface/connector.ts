/** A tracker outside the team (an issue host today), as a document names it. */
export interface ConnectorName {
  /** Stable, and the `source` of every task the connector's import wrote. */
  readonly id: string;
  /** What a person calls it. */
  readonly name: string;
}

/** The item a task's ref names on a tracker. */
export interface ConnectorItem {
  /** The item as the tracker's own people write it: `owner/name#12`. */
  readonly id: string;
  /** The item's page for a person to open; null when the tracker has none. */
  readonly url: string | null;
}

/**
 * One tracker, as far as the documents need it: its name, and which refs are its items. The documents know trackers
 * only through this port, so a second tracker is one more entry in the list the command passes and no reader of a
 * document changes.
 */
export interface Connector extends ConnectorName {
  /** The item `ref` names on this tracker, or undefined when the ref is not one of its. */
  itemOf(ref: string): ConnectorItem | undefined;
}
