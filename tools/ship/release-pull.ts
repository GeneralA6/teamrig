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

/** Whether a path is edited in place as the plain file it was: no add, delete, type or mode change (T4712 C4). */
const plainEdit = (changed: ChangedPath): boolean => changed.status === 'M' && changed.oldMode === PLAIN_FILE && changed.newMode === PLAIN_FILE;

/**
 * The version a version file's change raises it to, or why it is no version raise: the file must stay a plain file
 * and change only its version token, to a version above the merge base's.
 */
function versionRaise(git: GitText, from: string, sha: string, changed: ChangedPath, file: VersionFile): { readonly reason: string } | { readonly version: Version } {
  if (!plainEdit(changed)) {
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

/** A `git diff -U0` hunk header: the old start and count, the new start and count; a count left out is 1. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/**
 * Why the changelog's change is more than its version's notes, or null when it is one block of lines added after the
 * changelog's first line (its title), as release-please writes them: no line deleted or rewritten, nothing added in a
 * second place or above the title, and the file stays a plain text file (T4712 C4, C5).
 */
function changelogRefusal(git: GitText, from: string, sha: string, changed: ChangedPath): string | null {
  if (!plainEdit(changed)) {
    return `${changed.path} is the changelog the release pull request may only add lines to, but its change is ${changed.status} ${changed.oldMode} to ${changed.newMode}`;
  }
  const hunks = git(['diff', '-U0', '--no-renames', '--no-ext-diff', '--no-textconv', from, sha, '--', changed.path])
    .split('\n')
    .flatMap((line) => {
      const match = HUNK.exec(line);
      return match === null ? [] : [{ oldStart: Number(match[1]), oldCount: Number(match[2] ?? '1') }];
    });
  const [hunk] = hunks;
  if (hunk === undefined) return `${changed.path} is not text`;
  const deleted = hunks.reduce((sum, one) => sum + one.oldCount, 0);
  if (deleted > 0) return `${changed.path} deletes or rewrites ${deleted} line(s): the release pull request may only add its version's notes`;
  if (hunks.length > 1) return `${changed.path} changes ${hunks.length} places: the release pull request adds its version's notes in one block`;
  return hunk.oldStart === 0 ? `${changed.path} adds lines above its title: the release pull request adds its version's notes below it` : null;
}

/**
 * Why `sha` is not one commit straight on `from`, its merge base with main, or null when it is: release-please writes
 * its release as exactly one commit, and a branch of more would hide a commit whose change a later one undoes, as the
 * diff from the merge base shows only their sum while a rebase merge lands each (T4712 C4).
 */
function oneCommitRefusal(git: GitText, mainRef: string, from: string, sha: string): string | null {
  const [, ...parents] = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ');
  if (parents.length === 1 && parents[0] === from) return null;
  return `the release pull request's head ${sha} is not one commit on ${mainRef}: release-please writes its release as exactly one`;
}

/**
 * Why the release pull request's head `sha` may not merge into `mainRef`, or null when it may: each path it changes
 * from their merge base is either a version file (`versionFiles`, the repo profile's regenerated files that are no
 * folder) with only its version token raised, every one of them to one version, or the profile's changelog with lines
 * only added. Any other path, a deleted or mode-changed one, a head of more than one commit, or a head that changes
 * nothing is refused, naming why.
 */
export function releaseRefusal(git: GitText, mainRef: string, sha: string, release: ReleasePull, versionFiles: readonly VersionFile[]): string | null {
  const from = git(['merge-base', mainRef, sha]).trim();
  const commits = oneCommitRefusal(git, mainRef, from, sha);
  if (commits !== null) return commits;
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
