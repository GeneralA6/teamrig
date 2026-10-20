import { type Version, type VersionFile, bumpKindOf, bumped, formatVersion, versionIn, versionMention, withVersion } from './version-bump.ts';

/**
 * Brings a change branch up to main at the start of a ship, while the ship holds the host lock (T629). A ship
 * used to rebase and set its version before it queued for the lock; when other ships merged during the wait
 * (up to an hour), main moved past it and the ship was refused after the whole wait. Inside the lock no other
 * ship merges, so a branch rebased here and merged in the same run cannot go stale.
 *
 * The change's version raise is uncommitted, in the plan's last chunk (SKILL.md): it is set aside, the branch
 * and the plan's other uncommitted files are moved onto main, and the same raise (patch, minor or major) is
 * set again on main's version. A conflict, a committed raise, or the old version named anywhere else in the
 * change is refused before any check runs, with the work left as it was.
 */

export interface SyncDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  git: (...args: string[]) => string;
  /** A file of the working tree, by its path in the repo. */
  readText: (path: string) => string;
  writeText: (path: string, text: string) => void;
  log: (line: string) => void;
}

export interface SyncOptions {
  /** The branch merged into, on origin. */
  readonly main: string;
  /** The places the version is set; the first is read, all are written. */
  readonly files: readonly VersionFile[];
  /** Folders the build writes, left out when looking for the old version (the build sets them again). */
  readonly generated: readonly string[];
}

export type SyncResult =
  | { readonly kind: 'current' }
  | { readonly kind: 'rebased'; readonly onto: string; readonly version: { readonly from: string; readonly to: string } | null };

const refuse = (reason: string): never => {
  throw new Error(`REFUSED ${reason}`);
};

export function syncToMain(deps: SyncDeps, options: SyncOptions): SyncResult {
  const { git } = deps;
  const { main, files } = options;
  const [primary] = files;
  if (primary === undefined) throw new Error('syncToMain needs at least one version file');
  git('fetch', '--quiet', 'origin', main);
  const tip = git('rev-parse', `refs/remotes/origin/${main}`);
  const base = git('merge-base', 'HEAD', tip);
  if (base === tip) return { kind: 'current' };
  const short = tip.slice(0, 7);
  deps.log(`origin/${main} moved to ${short} since the branch was cut: rebasing onto it`);

  const versionAt = (rev: string, file: VersionFile): Version => versionIn(git('show', `${rev}:${file.path}`), file);
  if (formatVersion(versionAt('HEAD', primary)) !== formatVersion(versionAt(base, primary))) {
    refuse(`a commit of the branch raises the version in ${primary.path}: leave the raise uncommitted, in the plan, so the ship sets it from origin/${main}`);
  }
  const set = versionIn(deps.readText(primary.path), primary);
  const kind = bumpKindOf(versionAt(base, primary), set);

  for (const file of files) {
    const numstat = git('diff', '--numstat', 'HEAD', '--', file.path);
    if (numstat !== '' && !numstat.startsWith('1\t1\t')) refuse(`${file.path} has uncommitted changes besides its version: commit them in the branch first`);
  }
  const putBack = (): void => {
    for (const file of files) deps.writeText(file.path, withVersion(deps.readText(file.path), file, set));
  };
  git('checkout', '--', ...files.map((file) => file.path));
  const stashed = git('status', '--porcelain', '--untracked-files=no') !== '';
  if (stashed) git('stash', 'push', '--quiet', '-m', 'ship.ts: the plan, set aside for the rebase onto main');
  try {
    git('rebase', '--quiet', tip);
  } catch {
    git('rebase', '--abort');
    if (stashed) git('stash', 'pop', '--quiet');
    putBack();
    refuse(`rebasing onto origin/${main} ${short} conflicts: rebase by hand, then ship again`);
  }
  if (stashed) {
    try {
      git('stash', 'pop', '--quiet');
    } catch {
      refuse(`the plan's uncommitted changes conflict with origin/${main} ${short}: they stay in git stash; resolve the conflict, then ship again`);
    }
  }
  if (kind === null) return { kind: 'rebased', onto: tip, version: null };

  const to = bumped(versionAt(tip, primary), kind);
  for (const file of files) deps.writeText(file.path, withVersion(deps.readText(file.path), file, to));
  const from = formatVersion(set);
  const version = { from, to: formatVersion(to) };
  deps.log(`version ${from} -> ${version.to}: origin/${main} is at ${formatVersion(versionAt(tip, primary))}, the change raises its ${kind}`);
  if (from !== version.to) {
    const named = filesNaming(git, tip, from, [...files.map((file) => file.path), ...options.generated]);
    if (named.length > 0) refuse(`the change names its old version ${from} in ${named.join(', ')}: set it to ${version.to} there, then ship again`);
  }
  return { kind: 'rebased', onto: tip, version };
}

/** The files whose lines added since `rev` (working tree included) contain `text`, outside `skipped`. */
function filesNaming(git: SyncDeps['git'], rev: string, text: string, skipped: readonly string[]): string[] {
  const diff = git('diff', '--unified=0', rev, '--', '.', ...skipped.map((path) => `:(exclude)${path}`));
  const mention = versionMention(text);
  const named = new Set<string>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('+') && mention.test(line)) named.add(file);
  }
  return [...named];
}
