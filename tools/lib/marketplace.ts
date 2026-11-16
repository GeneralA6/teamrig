import { isRecord, stringField } from './guards.ts';

/** The marketplace catalog at the repo root, which names the plugins this repo ships. */
export const MARKETPLACE = '.claude-plugin/marketplace.json';

/** A plugin this repo ships: its marketplace name and its folder, `/`-separated from the repo root ('' for the root). */
export interface ShippedPlugin {
  readonly name: string;
  readonly folder: string;
}

export interface Catalog {
  readonly plugins: readonly ShippedPlugin[];
  readonly problems: readonly string[];
}

/**
 * Reads the marketplace catalog: the plugins whose source is a folder in this repo. An entry must not
 * give a version: Claude Code installs the one in plugin.json and ignores the entry's, so a second
 * copy can only drift from it.
 */
export function readCatalog(text: string): Catalog {
  const catalog: unknown = JSON.parse(text);
  const list: unknown = isRecord(catalog) ? catalog['plugins'] : undefined;
  if (!Array.isArray(list)) {
    throw new Error(`${MARKETPLACE} has no "plugins" list`);
  }
  const entries: readonly unknown[] = list;
  const plugins: ShippedPlugin[] = [];
  const problems: string[] = [];
  for (const entry of entries.filter(isRecord)) {
    const name = stringField(entry, 'name') ?? '(unnamed)';
    if ('version' in entry) {
      problems.push(`${name}: drop "version" from its ${MARKETPLACE} entry; Claude Code installs the version in plugin.json and ignores this one`);
    }
    const source = stringField(entry, 'source');
    if (source?.startsWith('./')) {
      plugins.push({ name, folder: source.slice(2).replace(/\/+$/, '') });
    }
  }
  return { plugins, problems };
}
