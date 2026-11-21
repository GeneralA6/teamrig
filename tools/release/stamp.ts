import { NEXT_RELEASE } from '../../src/config/migrate.ts';

/**
 * Release stamps (#1768): a config migration's `firstRelease` and a docs `(since <version>)` line name the release
 * that first ships them. The release pull request raises the version, so no author knows it when writing the change,
 * and a catch-up onto a newer main would not set a guessed one again. An author writes the stamp as `next`; the
 * release workflow sets each one to the version of the release pull request it runs on (stamp-cli.ts), so the
 * merged release carries them into main.
 */

/**
 * A stamp the tool sets, as written in each kind of file: `since next` in parentheses in a docs page or the schema, a
 * migration's `firstRelease` quoting `next`. Named here only in words, so this file holds no stamp itself.
 */
const FIRST_RELEASE = 'firstRelease: ';
const MARKERS: readonly { readonly pattern: RegExp; readonly stamped: (version: string) => string }[] = [
  { pattern: new RegExp(`\\(since ${NEXT_RELEASE}\\)`, 'g'), stamped: (version) => `(since ${version})` },
  // src/config/migrate.ts's constant for the word, or the word itself quoted.
  { pattern: new RegExp(`${FIRST_RELEASE}(?:NEXT_RELEASE\\b|'${NEXT_RELEASE}')`, 'g'), stamped: (version) => `${FIRST_RELEASE}'${version}'` },
];

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The tracked files a stamp may sit in: the config migrations, the docs, the guide the plugin ships, and the config
 * schema with the page made from it, which take the same text so the page stays as the schema makes it.
 */
export function holdsStamps(path: string): boolean {
  return (
    path === 'src/config/migrate.ts' ||
    path === 'plugins/teamrig/config.schema.json' ||
    path === 'README.md' ||
    ((path.startsWith('docs/') || path.startsWith('plugins/teamrig/skills/')) && path.endsWith('.md'))
  );
}

/** How many stamps `text` holds still to set. */
export function markersIn(text: string): number {
  return MARKERS.reduce((count, { pattern }) => count + (text.match(pattern)?.length ?? 0), 0);
}

/** `text` with each stamp still to set set to `version`. Throws on a version that is not MAJOR.MINOR.PATCH. */
export function stampText(text: string, version: string): string {
  if (!VERSION.test(version)) throw new Error(`${version} is not a MAJOR.MINOR.PATCH version`);
  return MARKERS.reduce((stamped, { pattern, stamped: to }) => stamped.replace(pattern, to(version)), text);
}

/** A file and the stamps it holds. */
export interface StampFinding {
  readonly path: string;
  readonly count: number;
}

/**
 * The stamps no release would set: each tracked file outside `holdsStamps` that holds one, as the release workflow
 * stamps only those files. `files` maps each tracked path to its text.
 */
export function strayStamps(files: ReadonlyMap<string, string>): readonly StampFinding[] {
  return [...files]
    .filter(([path]) => !holdsStamps(path))
    .map(([path, text]) => ({ path, count: markersIn(text) }))
    .filter(({ count }) => count > 0);
}
