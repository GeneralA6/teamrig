import { compareVersions, parseVersion } from '../../src/core/release-version.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import type { Git } from '../lib/git.ts';
import { isRecord, stringField } from '../lib/guards.ts';

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

/** The ends of the change to check: `base` is main (or the commit before a push), `head` the change. */
export interface Comparison {
  readonly base: string;
  readonly head: string;
}

export interface PluginVersionDeps {
  readonly git: Git;
  readonly out: (line: string) => void;
}

interface Verdict {
  readonly ok: boolean;
  readonly line: string;
}

/** Reads a file at a revision, or `undefined` when that revision has no such file. */
async function readAt(git: Git, revision: string, path: string): Promise<string | undefined> {
  const listed = await git.text(['ls-tree', '--name-only', revision, '--', path]);
  return listed.trim() === '' ? undefined : git.text(['show', `${revision}:${path}`]);
}

/** The "version" string a plugin.json gives, if any. */
function versionField(manifest: string): string | undefined {
  const parsed: unknown = JSON.parse(manifest);
  return isRecord(parsed) ? stringField(parsed, 'version') : undefined;
}

async function checkPlugin(plugin: ShippedPlugin, ends: Comparison, changed: readonly string[], git: Git): Promise<Verdict> {
  const prefix = plugin.folder === '' ? '' : `${plugin.folder}/`;
  const manifest = `${prefix}.claude-plugin/plugin.json`;
  const headText = await readAt(git, ends.head, manifest);
  if (headText === undefined) {
    return { ok: false, line: `${plugin.name}: ${manifest} is missing` };
  }
  const headRaw = versionField(headText);
  const headVersion = headRaw === undefined ? undefined : parseVersion(headRaw);
  if (headRaw === undefined || headVersion === undefined) {
    return { ok: false, line: `${plugin.name}: ${manifest} needs a "version" of the form MAJOR.MINOR.PATCH, found ${JSON.stringify(headRaw ?? null)}` };
  }
  const touched = changed.filter((path) => path.startsWith(prefix)).length;
  const where = prefix === '' ? 'the repo' : prefix;
  if (touched === 0) {
    return { ok: true, line: `${plugin.name} ${headRaw}: nothing under ${where} changed` };
  }
  const baseText = await readAt(git, ends.base, manifest);
  const baseRaw = baseText === undefined ? undefined : versionField(baseText);
  const baseVersion = baseRaw === undefined ? undefined : parseVersion(baseRaw);
  if (baseRaw === undefined || baseVersion === undefined) {
    return { ok: true, line: `${plugin.name} ${headRaw}: the base gives no version to raise` };
  }
  if (compareVersions(headVersion, baseVersion) > 0) {
    return { ok: true, line: `${plugin.name} ${baseRaw} -> ${headRaw}: ${touched} file(s) under ${where} changed` };
  }
  return {
    ok: false,
    line:
      `${plugin.name}: ${touched} file(s) under ${where} changed, but ${manifest} still gives ${headRaw} (the base: ${baseRaw}); ` +
      'raise it, or installed copies never receive the change',
  };
}

/**
 * The release check: a change to anything under a plugin's folder must raise that plugin's
 * plugin.json version above the base's, because `claude plugin update` moves an install only when
 * the version rises; and no marketplace entry may give a version of its own.
 */
export async function checkPluginVersions(ends: Comparison, deps: PluginVersionDeps): Promise<number> {
  const catalogText = await readAt(deps.git, ends.head, MARKETPLACE);
  if (catalogText === undefined) {
    throw new Error(`${MARKETPLACE} is missing at ${ends.head}`);
  }
  const catalog = readCatalog(catalogText);
  if (catalog.plugins.length === 0) {
    throw new Error(`${MARKETPLACE} names no plugin from a folder in this repo (a "./" source)`);
  }
  const mergeBase = (await deps.git.text(['merge-base', ends.base, ends.head])).trim();
  const diff = await deps.git.text(['diff', '--no-renames', '--name-only', '-z', mergeBase, ends.head]);
  const changed = diff.split('\0').filter((path) => path !== '');
  let failures = catalog.problems.length;
  for (const problem of catalog.problems) {
    deps.out(`plugin-version: ${problem}`);
  }
  for (const plugin of catalog.plugins) {
    const verdict = await checkPlugin(plugin, ends, changed, deps.git);
    deps.out(`plugin-version: ${verdict.line}`);
    failures += verdict.ok ? 0 : 1;
  }
  return failures === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}
