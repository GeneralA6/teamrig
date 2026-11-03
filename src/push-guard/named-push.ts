import type { GitConfigReader } from './invocations.ts';

/**
 * What an earlier command in the line may have changed of where a branch named alone pushes:
 * - `config`: it wrote remote, push or branch keys, or renamed or removed a remote, so the config read before the
 *   line may be stale;
 * - `upstream`: it created a branch or gave one an upstream, which `push.default` upstream sends it to.
 */
export type MapChange = 'none' | 'upstream' | 'config';

/** Where git sends a branch named alone: to the remote ref `ref` (`refs/heads/main` or `main`), or a doubt why the guard cannot tell. */
export type NamedPushTarget = { readonly kind: 'to'; readonly ref: string } | { readonly kind: 'doubt'; readonly doubt: string };

/** `tracking` is git's old name for `upstream`. Git reads the value case-sensitively; reading it in any case asks more, never less. */
const UPSTREAM_DEFAULTS: ReadonlySet<string> = new Set(['upstream', 'tracking']);

const doubtOf = (doubt: string): NamedPushTarget => ({ kind: 'doubt', doubt });

/**
 * Where `git push <remote> <branch>` sends a branch it names alone (no `:<dst>`), as git maps such a refspec
 * (builtin/push.c `refspec_append_mapped`): through a `remote.<remote>.push` refspec matching it, else under
 * `push.default` upstream through the branch's `branch.<branch>.merge`, else to its own name. So a worktree branch cut
 * from origin/main, pushed by name under `push.default` upstream, lands on main.
 *
 * A set `remote.<remote>.push` is a doubt rather than matched here: few repositories set one, and its refspecs may be
 * globs, several, or forced. A merge ref git would skip (no `branch.<branch>.remote`, several values) still counts,
 * which only asks more.
 */
export function namedPushTarget(repo: GitConfigReader, dir: string, remote: string, branch: string, change: MapChange): NamedPushTarget {
  if (change === 'config') {
    return doubtOf('an earlier command in the line changes the git config that says where a branch named alone pushes');
  }
  const pushes = repo.config(dir, `remote.${remote}.push`);
  if (pushes.kind !== 'unset') {
    return doubtOf(
      pushes.kind === 'set'
        ? `remote.${remote}.push in the git config can send a branch named alone to another branch`
        : `git cannot read remote.${remote}.push, which can send a branch named alone to another branch`,
    );
  }
  const pushDefault = repo.config(dir, 'push.default');
  if (pushDefault.kind === 'unreadable') {
    return doubtOf('git cannot read push.default, which can send a branch named alone to its upstream');
  }
  if (pushDefault.kind === 'unset' || !UPSTREAM_DEFAULTS.has(pushDefault.value.trim().toLowerCase())) {
    return { kind: 'to', ref: branch };
  }
  if (change === 'upstream') {
    return doubtOf('an earlier command in the line creates a branch or sets its upstream, where push.default upstream sends it');
  }
  const merge = repo.config(dir, `branch.${branch}.merge`);
  if (merge.kind === 'unreadable') {
    return doubtOf(`git cannot read branch.${branch}.merge, the upstream push.default upstream sends it to`);
  }
  return { kind: 'to', ref: merge.kind === 'set' ? merge.value.trim() : branch };
}
