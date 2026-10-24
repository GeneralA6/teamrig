import { isDeepStrictEqual } from 'node:util';
import { isRecord, type JsonRecord } from '../core/guards.ts';

/**
 * Does a change to a repository's root package files need a dependency install? A package.json change that only
 * edits fields no install reads (a tool's settings, the package's description) or scripts no install hook can reach
 * leaves node_modules valid; anything else (a dependency, override, engine or any other field, an install hook, a
 * script a hook runs, an unreadable file) needs the install, and so does any package-lock.json change.
 */

/** What a package.json change does to the installed node_modules. */
export type ManifestChange = 'none' | 'no-install' | 'install';

/** What a range changes in the root package files. */
export interface PackageFilesChange {
  /** package-lock.json changed. */
  readonly lockfile: boolean;
  readonly manifest: ManifestChange;
}

export const MANIFEST_FILE = 'package.json';
export const LOCKFILE = 'package-lock.json';

/** The root package's lifecycle scripts `npm ci` and `npm install` run. */
export const INSTALL_HOOKS: readonly string[] = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'];

/**
 * The root package.json fields `npm ci` and `npm install` never read: tools' settings, which the tool reads when it
 * runs, and the package's description for a registry. A field not listed counts as one an install reads.
 */
export const NO_INSTALL_FIELDS: readonly string[] = [
  'jest', 'prettier', 'eslintConfig', 'eslintIgnore', 'stylelint', 'lint-staged', 'browserslist', 'babel', 'nyc', 'c8', 'mocha', 'ava', 'commitlint',
  'description', 'keywords', 'author', 'contributors', 'maintainers', 'license', 'homepage', 'repository', 'bugs', 'funding',
];

function parseManifest(text: string): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function scriptsOf(manifest: JsonRecord): JsonRecord {
  const scripts = manifest['scripts'];
  return isRecord(scripts) ? scripts : {};
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a script command names `name` as a whole token: `npm run name` does, `name:sub` stays distinct. */
function mentions(command: unknown, name: string): boolean {
  return typeof command === 'string' && new RegExp(`(^|[^\\w:-])${escapeRegExp(name)}($|[^\\w:-])`).test(command);
}

/** Every script an install hook runs, directly or through other scripts, in either version. */
function reachableFromHooks(before: JsonRecord, after: JsonRecord): Set<string> {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const reached = new Set(INSTALL_HOOKS.filter((hook) => names.has(hook)));
  const queue = [...reached];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    const commands = [before[current], after[current]];
    for (const name of names) {
      if (!reached.has(name) && commands.some((command) => mentions(command, name))) {
        reached.add(name);
        queue.push(name);
      }
    }
  }
  return reached;
}

/**
 * Classifies a package.json change from its text before and after (undefined: no file). A missing or unparseable
 * side counts as an install change (both missing: none), so the answer is never less safe than "a dependency change".
 */
export function classifyManifestChange(before: string | undefined, after: string | undefined): ManifestChange {
  if (before === undefined && after === undefined) {
    return 'none';
  }
  const old = before === undefined ? undefined : parseManifest(before);
  const next = after === undefined ? undefined : parseManifest(after);
  if (old === undefined || next === undefined) {
    return 'install';
  }
  const fields = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter((field) => field !== 'scripts' && !isDeepStrictEqual(old[field], next[field]));
  if (fields.some((field) => !NO_INSTALL_FIELDS.includes(field))) {
    return 'install';
  }
  const oldScripts = scriptsOf(old);
  const nextScripts = scriptsOf(next);
  const changed = [...new Set([...Object.keys(oldScripts), ...Object.keys(nextScripts)])].filter((name) => !isDeepStrictEqual(oldScripts[name], nextScripts[name]));
  if (changed.length === 0) {
    return fields.length === 0 ? 'none' : 'no-install';
  }
  const reached = reachableFromHooks(oldScripts, nextScripts);
  return changed.some((name) => reached.has(name)) ? 'install' : 'no-install';
}

/** Whether the change needs a dependency install (`npm ci`) to keep node_modules matching the repository. */
export function needsInstall(change: PackageFilesChange): boolean {
  return change.lockfile || change.manifest === 'install';
}

/** The root package files' texts at either end of a range, read only when the range touches package.json. */
export type ManifestAt = (end: 'before' | 'after') => Promise<string | undefined>;

/** What a range with these changed paths does to the root package files. */
export async function packageFilesChange(paths: readonly string[], manifestAt: ManifestAt): Promise<PackageFilesChange> {
  const manifest = paths.includes(MANIFEST_FILE) ? classifyManifestChange(await manifestAt('before'), await manifestAt('after')) : 'none';
  return { lockfile: paths.includes(LOCKFILE), manifest };
}

/** The changed root package files that need the install, as the refusal names them; empty when none does. */
export function installTouches(change: PackageFilesChange): string[] {
  return [...(change.lockfile ? [LOCKFILE] : []), ...(change.manifest === 'install' ? [`${MANIFEST_FILE} fields an install reads`] : [])];
}
