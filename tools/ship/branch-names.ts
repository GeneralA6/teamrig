/**
 * A new name for a change branch that goes again after main moved past it: a pushed branch is never rewritten (the
 * lead's ruling of 11-06), so a rebased one is pushed as `<stem>-N` (T2696 for a ship, T2809 for a merge).
 */

/** The first `<stem>-N`, N from 2, that names no branch here or on origin; `git` runs in the repo dir and returns trimmed stdout. */
export function freeBranch(git: (...args: string[]) => string, stem: string): string {
  for (let n = 2; ; n++) {
    const name = `${stem}-${n}`;
    if (git('branch', '--list', name) === '' && git('ls-remote', '--heads', 'origin', `refs/heads/${name}`) === '') return name;
  }
}
