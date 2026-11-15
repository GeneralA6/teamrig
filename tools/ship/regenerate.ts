import { isRegenerated, parseLog } from './leftovers.ts';
import { mentionsIn } from './sync.ts';
import { DIST, DIST_SUBJECT, TRAILER, parseNumstat, weighDist } from './ship-commits.ts';
import { type BumpKind, type Version, type VersionFile, TEAMRIG_VERSION_FILES, bumpKindOf, bumped, compareVersions, formatVersion, versionIn, versionMention, withVersion } from './version-bump.ts';

/**
 * The version raise and the dist of a pushed teamrig change, made again on a main that moved past it (T2988), so a
 * reviewed pull request survives any merge to main. Every merge to main raises the plugin version and rebuilds the
 * dist, so a plain rebase of a change that does the same always conflicts on those files. The change's commits of
 * only those files are dropped, its work commits are replayed on main's tip one by one, and the raise is made again
 * on main's version, the same kind (major, minor, patch) with the same commit message, before the dist is rebuilt
 * from the replayed source. What the reviewer approved, the work, is held equal by catch-up.ts.
 */

export interface Regeneration {
  /** The files that carry the plugin version, which the change raised once in a commit of their own. */
  readonly versionFiles: readonly VersionFile[];
  /** The folder `npm run build` writes, committed apart from the work. */
  readonly dist: string;
}

export const TEAMRIG_REGENERATION: Regeneration = { versionFiles: TEAMRIG_VERSION_FILES, dist: DIST };

/** The paths of a regeneration as repos.json lists them: a folder ends in `/` (leftovers.ts `isRegenerated`). */
export const listedPaths = (regeneration: Regeneration): readonly string[] => [`${regeneration.dist}/`, ...regeneration.versionFiles.map((file) => file.path)];

/**
 * teamrig's regeneration when a repo's profile calls exactly its version files and dist regenerated; null for any
 * other list (teamrig-pane raises its plugin.json by hand and builds no dist), which catch-up rebases as it was.
 */
export function regenerationFor(regenerated: readonly string[]): Regeneration | null {
  const ours = listedPaths(TEAMRIG_REGENERATION);
  return regenerated.length === ours.length && ours.every((path) => regenerated.includes(path)) ? TEAMRIG_REGENERATION : null;
}

/** git's pathspec for every path but the regenerated ones. */
export const workPathspec = (regeneration: Regeneration): readonly string[] => ['.', ...listedPaths(regeneration).map((path) => `:(exclude)${path}`)];

/** The version raise a change made, to make again on the moved main. */
export interface Raise {
  readonly kind: BumpKind;
  /** The version the change set. */
  readonly set: Version;
  /** The message of the change's commit that raised it, which the raise on main keeps with the new version in it. */
  readonly message: string;
}

export interface ReplayPlan {
  /** The commits that carry the work, oldest first: every commit of the change but its version and dist ones. */
  readonly work: readonly string[];
  /** The raise to make again; null when the change raised no version. */
  readonly raise: Raise | null;
  /** Whether the change carried a dist, which is then built again from the replayed source. */
  readonly rebuild: boolean;
}

type Git = (...args: string[]) => string;

const versionAt = (git: Git, rev: string, file: VersionFile): Version => versionIn(git('show', `${rev}:${file.path}`), file);

/**
 * How to replay the change `base..sha` on main's tip, or why it cannot be: a merge commit, a commit that mixes work
 * with the version or the dist, a version file changed with no raise, or work that writes the raised version down
 * when the raise on main sets another (a doc's "since 0.416.0" would go stale). Any of those ships again with its plan
 * (`ship.ts <dir> <plan.json> --merge`), which sets the raise and the mentions on main's version (sync.ts).
 */
export function planReplay(git: Git, regeneration: Regeneration, base: string, sha: string, tip: string): ReplayPlan | string {
  const listed = listedPaths(regeneration);
  const commits = parseLog(git('log', '--reverse', '--format=%x00%H %P', '--name-only', `${base}..${sha}`));
  const merge = commits.find((commit) => commit.parents.length > 1);
  if (merge !== undefined) return `it holds the merge commit ${merge.sha.slice(0, 9)}, which is not replayed`;
  const mixed = commits.find((commit) => commit.files.some((file) => isRegenerated(file, listed)) && commit.files.some((file) => !isRegenerated(file, listed)));
  if (mixed !== undefined) return `its commit ${mixed.sha.slice(0, 9)} changes the version files or the dist together with its work, so they cannot be made again apart`;

  const dropped = commits.filter((commit) => commit.files.length > 0 && commit.files.every((file) => isRegenerated(file, listed)));
  const versionPaths = regeneration.versionFiles.map((file) => file.path);
  const raised = dropped.filter((commit) => commit.files.some((file) => versionPaths.includes(file))).at(-1);
  const rebuild = dropped.some((commit) => commit.files.some((file) => file.startsWith(`${regeneration.dist}/`)));
  const work = commits.filter((commit) => !dropped.includes(commit)).map((commit) => commit.sha);
  const [first] = regeneration.versionFiles;
  if (raised === undefined || first === undefined) return { work, raise: null, rebuild };

  const set = versionAt(git, sha, first);
  const kind = bumpKindOf(versionAt(git, base, first), set);
  if (kind === null) return `its commit ${raised.sha.slice(0, 9)} changes a version file without raising the version ${formatVersion(set)}`;
  const to = bumped(versionAt(git, tip, first), kind);
  if (compareVersions(to, set) !== 0) {
    const named = mentionsIn(git('diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', base, sha, '--', ...workPathspec(regeneration)), versionMention(formatVersion(set)));
    if (named.size > 0) return `its work names the version ${formatVersion(set)} it raised to (${[...named.keys()].join(', ')}), which becomes ${formatVersion(to)} on that tip`;
  }
  return { work, raise: { kind, set, message: git('log', '-1', '--format=%B', raised.sha) }, rebuild };
}

export interface RegenerateDeps {
  git: Git;
  /** Reads a file of the repo dir as it is on disk, by its path in the repo: `git` trims what it prints. */
  readText: (path: string) => string;
  /** Writes a file of the repo dir, by its path in the repo. */
  writeText: (path: string, text: string) => void;
  /** Runs the repo's `npm run build` steps in the repo dir; throws when one fails. */
  build: () => void;
  log: (line: string) => void;
}

/**
 * Makes the change's raise again on the checked-out tip's version, in one commit with the change's own message and
 * its version replaced, then rebuilds the dist when the change carried one, in the commit a ship makes
 * (ship-commits.ts). Returns what it did, for the log.
 */
export function regenerate(deps: RegenerateDeps, regeneration: Regeneration, plan: ReplayPlan, tip: string): string {
  const { git } = deps;
  const done: string[] = [];
  if (plan.raise !== null) {
    const { raise } = plan;
    const [first] = regeneration.versionFiles;
    if (first === undefined) throw new Error('no version file to raise');
    const to = bumped(versionAt(git, tip, first), raise.kind);
    // The work commits replayed on the tip leave its version files as they are there.
    for (const file of regeneration.versionFiles) deps.writeText(file.path, withVersion(deps.readText(file.path), file, to));
    git('add', '--', ...regeneration.versionFiles.map((file) => file.path));
    git('commit', '-q', '-s', '-m', raise.message.replace(versionMention(formatVersion(raise.set), 'g'), formatVersion(to)));
    done.push(`raised the version ${formatVersion(raise.set)} again as ${formatVersion(to)}`);
  }
  if (plan.rebuild) {
    deps.build();
    git('add', '--', regeneration.dist);
    const files = parseNumstat(git('diff', '--cached', '--numstat'));
    if (files.length > 0) {
      const large = weighDist(files).large ? ['-m', 'Large-commit: generated by npm run build from the reviewed source'] : [];
      git('commit', '-q', '-s', '-m', DIST_SUBJECT, '-m', 'Compiled from the commits above by npm run build.', ...large, '-m', TRAILER);
    }
    done.push(files.length > 0 ? `rebuilt the dist (${files.length} file(s))` : 'rebuilt the dist, the same as before');
  }
  return done.length > 0 ? done.join(', ') : 'nothing to make again';
}
