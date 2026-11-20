import { GITHUB_CONNECTOR } from '../adapters/connectors/github/connector.ts';
import type { Connector } from '../plugin-api/index.ts';

/**
 * The trackers a document names a ref or a source by. Each is its adapter's, and only this folder may reach an
 * adapter, so a command takes the list from here; a second tracker is one more entry.
 */
export const DOCUMENT_CONNECTORS: readonly Connector[] = [GITHUB_CONNECTOR];
