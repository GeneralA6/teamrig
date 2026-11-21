import type { Connector, ConnectorName } from './connector.ts';
import type { MarkedText, ServedText } from './text.ts';

/**
 * Where a task's ask came from, as data. `text` is the stored ref and always there, since a ref is also free text
 * (a message, a file and line). The other four are filled together, only when a tracker knows the ref as one of its
 * items, so a reader shows a link without knowing how any tracker spells its refs.
 */
export interface ServedRef {
  readonly text: string;
  readonly connector: ConnectorName | null;
  /** The item as the tracker's own people write it. */
  readonly id: string | null;
  /** What to show for the link. It is the tracker's word, so it is marked outside text. */
  readonly label: MarkedText | null;
  readonly url: string | null;
}

/**
 * A tracker's page for an item, served only as an `https:` address and as the parser read it. A reader opens it, so
 * a `javascript:` or `file:` address a tracker answered is served as no link at all.
 */
function pageOf(url: string | null): string | null {
  if (url === null || !URL.canParse(url)) {
    return null;
  }
  const page = new URL(url);
  return page.protocol === 'https:' ? page.href : null;
}

/**
 * The ref of record `record` (a task's id), or null for a task with none. The first tracker that knows the ref
 * names it. A ref that matched a secret's shape is served as its cut alone: no tracker is asked, since an item's id
 * and page would repeat the text that was cut.
 */
export function refOf(served: ServedText, record: string, ref: string | null, connectors: readonly Connector[]): ServedRef | null {
  if (ref === null) {
    return null;
  }
  const text = served.plain(record, 'ref', ref);
  if (text !== ref) {
    return { text, connector: null, id: null, label: null, url: null };
  }
  for (const connector of connectors) {
    const item = connector.itemOf(ref);
    if (item !== undefined) {
      return {
        text,
        connector: { id: connector.id, name: connector.name },
        id: item.id,
        label: served.marked(record, 'ref.label', item.id, 'outside'),
        url: pageOf(item.url),
      };
    }
  }
  return { text, connector: null, id: null, label: null, url: null };
}
