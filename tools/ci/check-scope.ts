import { join, resolve } from 'node:path';
import { PASS_RECORD_FOLDER, passRecordPath } from '../../src/push-guard/pass-record.ts';
import { type RepoProfile, slugOf } from '../ship/repos.ts';

/**
 * What a local proof of a committed tree covers (T3414, T4344).
 * - `full`: every check CI runs. It is recorded as the tree's pass record, the proof every reader of a pass takes.
 * - `light`: the pre-push checks of a repo whose main merges on GitHub's required checks (the `ci` gate): the
 *   scrubs, the commit checks, the typecheck, the compile, the plugin's tests and the docs' checks, about
 *   45 s. The whole suite, the dist checks and the fresh install are left to CI, which runs them on every OS.
 * - `short`: the commit checks (scrub, DCO sign-off, size rule, subjects), the typecheck and the changed files' specs;
 *   every check when a changed file is part of the gate itself (local-checks.ts `gateChanges`, T4080). It is for a
 *   branch of a repo whose main merges only on GitHub's required checks (repos.json `"mergeChecks": "changed"`), which
 *   run the whole suite on the pull request.
 * A light or short proof's record lives apart, in `light/` or `short/`, so no reader of a pass record (a full proof,
 * `teamrig merge`'s self-merge gates) ever takes it for one, and neither takes the other's.
 */
export type CheckScope = 'full' | 'light' | 'short';

/** The folder in the pass-record folder that holds each partial scope's records. */
const FOLDER: Readonly<Record<Exclude<CheckScope, 'full'>, string>> = { light: 'light', short: 'short' };

/** Where the record of a partial proof of `tree` lives; `gitCommonDir` as `git rev-parse --git-common-dir` prints it. */
function partialRecordPath(scope: Exclude<CheckScope, 'full'>, root: string, gitCommonDir: string, tree: string): string {
  return join(resolve(root, gitCommonDir), PASS_RECORD_FOLDER, FOLDER[scope], `${tree}.json`);
}

/** Where the record of a short proof of `tree` lives. */
export function shortRecordPath(root: string, gitCommonDir: string, tree: string): string {
  return partialRecordPath('short', root, gitCommonDir, tree);
}

/** Where the record of a light proof of `tree` lives. */
export function lightRecordPath(root: string, gitCommonDir: string, tree: string): string {
  return partialRecordPath('light', root, gitCommonDir, tree);
}

/** Where a proof of `scope` writes its record. */
export function recordPathOf(scope: CheckScope, root: string, gitCommonDir: string, tree: string): string {
  return scope === 'full' ? passRecordPath(root, gitCommonDir, tree) : partialRecordPath(scope, root, gitCommonDir, tree);
}

/** The records that prove `tree` for `scope`, in the order to read them: a full pass proves a partial one too, never the other way. */
export function recordPathsFor(scope: CheckScope, root: string, gitCommonDir: string, tree: string): string[] {
  const full = passRecordPath(root, gitCommonDir, tree);
  return scope === 'full' ? [full] : [full, partialRecordPath(scope, root, gitCommonDir, tree)];
}

/**
 * The scope the pre-push hook proves a push with. For a remote repos.json lists with the `ci` gate and no update to its
 * main, it is short when the repo says `"mergeChecks": "changed"`, else light: GitHub's required checks run the rest
 * before anything lands. Every other push is full: a repo with the local gate, which has no CI behind it, a push to
 * main, a remote repos.json does not list, one not on GitHub, and a hook given no remote URL.
 */
export function pushScope(profiles: ReadonlyMap<string, RepoProfile>, remoteUrl: string | undefined, remoteRefs: readonly string[]): CheckScope {
  const profile = remoteUrl === undefined ? undefined : profileOfRemote(profiles, remoteUrl);
  if (profile === undefined || profile.gate !== 'ci') return 'full';
  if (remoteRefs.some((ref) => ref === `refs/heads/${profile.main}`)) return 'full';
  return profile.mergeChecks === 'changed' ? 'short' : 'light';
}

/** The profile of the repo a remote URL names; undefined when it is not a GitHub remote or repos.json does not list it. */
function profileOfRemote(profiles: ReadonlyMap<string, RepoProfile>, remoteUrl: string): RepoProfile | undefined {
  try {
    return profiles.get(slugOf(remoteUrl).toLowerCase());
  } catch {
    return undefined;
  }
}
