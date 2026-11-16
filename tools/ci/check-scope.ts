import { join, resolve } from 'node:path';
import { PASS_RECORD_FOLDER, passRecordPath } from '../../src/push-guard/pass-record.ts';
import { type RepoProfile, slugOf } from '../ship/repos.ts';

/**
 * What a local proof of a committed tree covers (T3414).
 * - `full`: every check CI runs. It is recorded as the tree's pass record, the proof every reader of a pass takes.
 * - `short`: the scrub, the DCO sign-off, the typecheck and the changed files' specs. It is for a branch of a repo
 *   whose main merges only on GitHub's required checks (repos.json `"mergeChecks": "changed"`), which run the whole
 *   suite on the pull request.
 * A short proof's record lives apart, in `short/`, so no reader of a pass record (the pre-push hook of a full proof,
 * `teamrig merge`'s self-merge gates) ever takes it for one.
 */
export type CheckScope = 'full' | 'short';

/** The folder in the pass-record folder that holds the short proofs' records. */
const SHORT_FOLDER = 'short';

/** Where the record of a short proof of `tree` lives; `gitCommonDir` as `git rev-parse --git-common-dir` prints it. */
export function shortRecordPath(root: string, gitCommonDir: string, tree: string): string {
  return join(resolve(root, gitCommonDir), PASS_RECORD_FOLDER, SHORT_FOLDER, `${tree}.json`);
}

/** Where a proof of `scope` writes its record. */
export function recordPathOf(scope: CheckScope, root: string, gitCommonDir: string, tree: string): string {
  return scope === 'full' ? passRecordPath(root, gitCommonDir, tree) : shortRecordPath(root, gitCommonDir, tree);
}

/** The records that prove `tree` for `scope`, in the order to read them: a full pass proves a short one too, never the other way. */
export function recordPathsFor(scope: CheckScope, root: string, gitCommonDir: string, tree: string): string[] {
  const full = passRecordPath(root, gitCommonDir, tree);
  return scope === 'full' ? [full] : [full, shortRecordPath(root, gitCommonDir, tree)];
}

/**
 * The scope the pre-push hook proves a push with. It is short only when repos.json lists the remote's repo with
 * `"mergeChecks": "changed"` (which needs the `ci` gate) and no update goes to its main. Every other push is full:
 * a remote repos.json does not list, one not on GitHub, and a hook given no remote URL.
 */
export function pushScope(profiles: ReadonlyMap<string, RepoProfile>, remoteUrl: string | undefined, remoteRefs: readonly string[]): CheckScope {
  const profile = remoteUrl === undefined ? undefined : profileOfRemote(profiles, remoteUrl);
  if (profile === undefined || profile.gate !== 'ci' || profile.mergeChecks !== 'changed') return 'full';
  return remoteRefs.every((ref) => ref !== `refs/heads/${profile.main}`) ? 'short' : 'full';
}

/** The profile of the repo a remote URL names; undefined when it is not a GitHub remote or repos.json does not list it. */
function profileOfRemote(profiles: ReadonlyMap<string, RepoProfile>, remoteUrl: string): RepoProfile | undefined {
  try {
    return profiles.get(slugOf(remoteUrl).toLowerCase());
  } catch {
    return undefined;
  }
}
