import type { GitText } from './approval.ts';
import type { ReleasePull } from './repos.ts';
import { compareVersions, formatVersion, versionIn, withVersion, type Version, type VersionFile } from './version-bump.ts';

/**
 * Whether the release pull request at `sha` holds only a release (T4645): what release-please writes, the version
 * raised in each version file and its notes added to the changelog. `ship.ts merge --release` merges that head on its
 * release task's approval, which names no branch of a change, so this check stands in for the change review a
 * branch's approval gives: anything else on the release branch is refused before the merge, naming the path.
 */

/** One path the release pull request changes, from `git diff --raw`. */
interface ChangedPath {
  readonly path: string;
  /** git's status letter: A added, M modified, D deleted, T type changed, and so on. */
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
}

/** The mode git gives a plain, non-executable file. */
const PLAIN_FILE = '100644';

/**
 * The paths `from..sha` changes, read NUL-separated so no path is quoted, and with renames off, so a rename shows as
 * the delete and the add it is.
 */
function changedPaths(git: GitText, from: string, sha: string): ChangedPath[] {
  const fields = git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, sha]).split('\0');
  const paths: ChangedPath[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode = '', newMode = '', , , status = ''] = (fields[i] ?? '').replace(/^:/, '').split(' ');
    paths.push({ path: fields[i + 1] ?? '', status, oldMode, newMode });
  }
  return paths;
}

const textAt = (git: GitText, ref: string, path: string): string => git(['cat-file', 'blob', `${ref}:${path}`]);

/**
 * The version a version file's change raises it to, or why it is no version raise: the file must keep its mode and
 * change only its version token, to a version above the merge base's.
 */
function versionRaise(git: GitText, from: string, sha: string, changed: ChangedPath, file: VersionFile): { readonly reason: string } | { readonly version: Version } {
  if (changed.status !== 'M' || changed.oldMode !== changed.newMode) {
    return { reason: `${changed.path} is a version file the release pull request must only edit, but its change is ${changed.status} ${changed.oldMode} to ${changed.newMode}` };
  }
  const baseText = textAt(git, from, changed.path);
  const headText = textAt(git, sha, changed.path);
  const base = versionIn(baseText, file);
  const head = versionIn(headText, file);
  if (withVersion(baseText, file, head) !== headText) {
    return { reason: `${changed.path} changes more than its version token` };
  }
  if (compareVersions(head, base) <= 0) {
    return { reason: `${changed.path} sets version ${formatVersion(head)}, which does not raise ${formatVersion(base)}` };
  }
  return { version: head };
}

/** Why the changelog's change adds anything but lines, or null when it only adds lines to a plain file. */
function changelogRefusal(git: GitText, from: string, sha: string, changed: ChangedPath): string | null {
  const plain = changed.newMode === PLAIN_FILE && (changed.status === 'A' || (changed.status === 'M' && changed.oldMode === PLAIN_FILE));
  if (!plain) {
    return `${changed.path} is the changelog the release pull request may only add lines to, but its change is ${changed.status} ${changed.oldMode} to ${changed.newMode}`;
  }
  const [, deleted = '-'] = git(['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', from, sha, '--', changed.path]).split('\t');
  if (deleted === '-') return `${changed.path} is not text`;
  return deleted === '0' ? null : `${changed.path} deletes or rewrites ${deleted} line(s): the release pull request may only add its version's notes`;
}

/**
 * Why the release pull request's head `sha` may not merge into `mainRef`, or null when it may: each path it changes
 * from their merge base is either a version file (`versionFiles`, the repo profile's regenerated files that are no
 * folder) with only its version token raised, every one of them to one version, or the profile's changelog with lines
 * only added. Any other path, a deleted or mode-changed one, or a head that changes nothing is refused, naming why.
 */
export function releaseRefusal(git: GitText, mainRef: string, sha: string, release: ReleasePull, versionFiles: readonly VersionFile[]): string | null {
  const from = git(['merge-base', mainRef, sha]).trim();
  const changed = changedPaths(git, from, sha);
  if (changed.length === 0) return `the release pull request's head ${sha} changes nothing over ${mainRef}`;
  const versions = new Set<string>();
  const raised = new Set<string>();
  for (const one of changed) {
    const file = versionFiles.find((known) => known.path === one.path);
    if (file !== undefined) {
      const raise = versionRaise(git, from, sha, one, file);
      if ('reason' in raise) return raise.reason;
      versions.add(formatVersion(raise.version));
      raised.add(one.path);
    } else if (one.path === release.changelog) {
      const reason = changelogRefusal(git, from, sha, one);
      if (reason !== null) return reason;
    } else {
      return `${one.path} is neither a version file nor the changelog ${release.changelog}: the release pull request carries a change no one approved`;
    }
  }
  const unraised = versionFiles.filter((file) => !raised.has(file.path)).map((file) => file.path);
  if (unraised.length > 0) return `the release pull request leaves the version of ${unraised.join(', ')} as it was: a release raises every version file`;
  if (versions.size > 1) return `the version files name more than one version: ${[...versions].join(', ')}`;
  return null;
}
