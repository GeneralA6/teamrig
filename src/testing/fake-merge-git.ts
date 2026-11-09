import type { GitOutcome } from '../core/git-run.ts';
import { ORIGIN, type Checkout, type MergeGit, type LocalUpdate } from '../merge/git.ts';

/** The linked worktree a fake merge runs in. */
export const WORKTREE = '/w/feat';
/** The main checkout that worktree belongs to. */
export const MAIN_CHECKOUT = '/repo/app';

const OK: GitOutcome = { ok: true };
const BRANCH_REF = 'refs/heads/';

function failed(reason: string | undefined): GitOutcome {
  return reason === undefined ? OK : { ok: false, reason };
}

/**
 * A repository for `teamrig merge`, in memory. The branch `feat` is checked out at commit `mine` in the linked
 * worktree `/w/feat`; its main checkout `/repo/app` is on `main` at `base`, where origin's `main` is too. A fetch
 * of a remote copies its branches to `<remote>/<name>`, a rebase moves HEAD to `rebasedTo` on top of what it rebased
 * onto, and each step that touches git is logged in `log`. A test sets a `...Fails` field to make that step fail,
 * calls `pushed` where a push lands, moves `origin` alone where another clone pushed, or adds a remote beside origin
 * to `remotes`.
 */
export class FakeMergeGit implements MergeGit {
  /** Each step, as `<step> <folder> <arguments>`. */
  readonly log: string[] = [];
  readonly checkouts = new Map<string, Checkout>([
    [WORKTREE, { top: WORKTREE, branch: 'feat', mainCheckout: MAIN_CHECKOUT, linked: true }],
    [MAIN_CHECKOUT, { top: MAIN_CHECKOUT, branch: 'main', mainCheckout: MAIN_CHECKOUT, linked: false }],
  ]);
  /** `git status --porcelain` lines by folder; untracked ones start with `??`. */
  readonly status = new Map<string, string[]>();
  /** Folders where `git status` fails. */
  readonly statusFails = new Set<string>();
  /** origin's branches. */
  readonly origin = new Map<string, string>([
    ['main', 'base'],
    ['feat', 'mine'],
  ]);
  /** The remotes beside origin, each with its branches; fetching a remote not here fails. */
  readonly remotes = new Map<string, Map<string, string>>();
  /** Each remote's branches as its last fetch copied them, by `<remote>/<branch>`. */
  readonly tracking = new Map<string, string>();
  readonly heads = new Map<string, string>([
    [WORKTREE, 'mine'],
    [MAIN_CHECKOUT, 'base'],
  ]);
  readonly branches = new Map<string, string>([
    ['main', 'base'],
    ['feat', 'mine'],
  ]);
  /** `<ancestor>><descendant>` pairs; every commit is its own ancestor too. */
  readonly ancestry = new Set<string>(['base>mine', 'base>rebased']);
  /** File texts by `<commit>:<path>`. */
  readonly files = new Map<string, string>();
  /** Trees by commit, where a test needs two commits to make one tree. */
  readonly trees = new Map<string, string>();
  defaultName = 'main';
  mergeBaseIs: string | undefined = 'base';
  paths: readonly string[] | undefined = ['src/app.ts'];
  /** The paths two commits differ in, by `<commit>..<commit>`; a pair not listed differs in `paths`, a commit and itself in none. */
  readonly diffs = new Map<string, readonly string[]>();
  /** The commits a range holds, oldest first, whatever its ends; a range from a commit to itself holds none. */
  landed: readonly string[] = ['rebased'];
  rebasedTo = 'rebased';
  localUpdate: LocalUpdate = { kind: 'checkedOut' };
  fetchFails: string | undefined;
  rebaseFails: string | undefined;
  deleteRemoteFails: string | undefined;
  detachFails: string | undefined;
  checkoutFails: string | undefined;
  fastForwardFails: string | undefined;
  resetFails: string | undefined;
  /** The `core.sshCommand` git's config sets; none by default. */
  sshCommandIs: string | undefined;

  /** A push of ours lands: origin's branch moves, and so does its tracking ref, as git push moves both. */
  pushed(branch: string, commit: string): void {
    this.origin.set(branch, commit);
    this.tracking.set(`${ORIGIN}/${branch}`, commit);
  }

  private branchesOf(remote: string): Map<string, string> | undefined {
    return remote === ORIGIN ? this.origin : this.remotes.get(remote);
  }

  private isTracking(ref: string): boolean {
    const slash = ref.indexOf('/');
    return slash > 0 && this.branchesOf(ref.slice(0, slash)) !== undefined;
  }

  private commitOf(dir: string, ref: string): string | undefined {
    if (ref === 'HEAD') {
      return this.heads.get(dir);
    }
    if (this.isTracking(ref)) {
      return this.tracking.get(ref);
    }
    if (ref.startsWith(BRANCH_REF)) {
      return this.branches.get(ref.slice(BRANCH_REF.length));
    }
    return ref;
  }

  checkoutOf(dir: string): Checkout | undefined {
    return this.checkouts.get(dir);
  }

  /** The `.git` folder of the checkout's main checkout. */
  commonDir(dir: string): string | undefined {
    const checkout = this.checkouts.get(dir);
    return checkout === undefined ? undefined : `${checkout.mainCheckout ?? checkout.top}/.git`;
  }

  changes(dir: string, untracked: boolean): readonly string[] | undefined {
    if (this.statusFails.has(dir)) {
      return undefined;
    }
    return (this.status.get(dir) ?? []).filter((line) => untracked || !line.startsWith('??'));
  }

  fetch(dir: string, remote: string): GitOutcome {
    this.log.push(`fetch ${dir} ${remote}`);
    const branches = this.branchesOf(remote);
    if (branches === undefined) {
      return failed(`'${remote}' does not appear to be a git repository`);
    }
    if (this.fetchFails === undefined) {
      const prefix = `${remote}/`;
      for (const ref of [...this.tracking.keys()].filter((key) => key.startsWith(prefix))) {
        this.tracking.delete(ref);
      }
      for (const [name, commit] of branches) {
        this.tracking.set(`${prefix}${name}`, commit);
      }
    }
    return failed(this.fetchFails);
  }

  defaultBranch(): string {
    return this.defaultName;
  }

  sshCommand(): string | undefined {
    return this.sshCommandIs;
  }

  sha(dir: string, ref: string): string | undefined {
    return this.commitOf(dir, ref);
  }

  /** A commit's tree is `tree-<commit>`, unless `trees` names another. */
  treeOf(dir: string, ref: string): string | undefined {
    const commit = this.commitOf(dir, ref);
    return commit === undefined ? undefined : (this.trees.get(commit) ?? `tree-${commit}`);
  }

  remoteHead(_dir: string, remote: string, branch: string): string | undefined {
    return this.branchesOf(remote)?.get(branch);
  }

  mergeBase(): string | undefined {
    return this.mergeBaseIs;
  }

  changedPaths(dir: string, base: string, head: string): readonly string[] | undefined {
    const from = this.commitOf(dir, base) ?? base;
    const to = this.commitOf(dir, head) ?? head;
    return from === to ? [] : (this.diffs.get(`${from}..${to}`) ?? this.paths);
  }

  fileAt(dir: string, ref: string, path: string): string | undefined {
    return this.files.get(`${this.commitOf(dir, ref) ?? ref}:${path}`);
  }

  commits(dir: string, from: string, to: string): readonly string[] {
    return this.commitOf(dir, from) === this.commitOf(dir, to) ? [] : this.landed;
  }

  isAncestor(dir: string, ancestor: string, descendant: string): boolean {
    const older = this.commitOf(dir, ancestor);
    const newer = this.commitOf(dir, descendant);
    return older !== undefined && newer !== undefined && (older === newer || this.ancestry.has(`${older}>${newer}`));
  }

  rebase(dir: string, onto: string): GitOutcome {
    this.log.push(`rebase ${dir} ${onto}`);
    if (this.rebaseFails !== undefined) {
      return failed(this.rebaseFails);
    }
    const base = this.commitOf(dir, onto);
    this.ancestry.add(`${base ?? onto}>${this.rebasedTo}`);
    this.heads.set(dir, this.rebasedTo);
    const branch = this.checkouts.get(dir)?.branch;
    if (branch !== undefined) {
      this.branches.set(branch, this.rebasedTo);
    }
    return OK;
  }

  deleteRemoteBranch(dir: string, branch: string): GitOutcome {
    this.log.push(`deleteRemoteBranch ${dir} ${branch}`);
    if (this.deleteRemoteFails === undefined) {
      this.origin.delete(branch);
    }
    return failed(this.deleteRemoteFails);
  }

  detach(dir: string): GitOutcome {
    this.log.push(`detach ${dir}`);
    const checkout = this.checkouts.get(dir);
    if (this.detachFails === undefined && checkout !== undefined) {
      this.checkouts.set(dir, { ...checkout, branch: undefined });
    }
    return failed(this.detachFails);
  }

  deleteBranch(dir: string, branch: string): GitOutcome {
    this.log.push(`deleteBranch ${dir} ${branch}`);
    this.branches.delete(branch);
    return OK;
  }

  updateLocalBranch(dir: string, remote: string, branch: string): LocalUpdate {
    this.log.push(`updateLocalBranch ${dir} ${remote} ${branch}`);
    const commit = this.tracking.get(`${remote}/${branch}`);
    if (this.localUpdate.kind === 'updated' && commit !== undefined) {
      this.branches.set(branch, commit);
    }
    return this.localUpdate;
  }

  checkout(dir: string, branch: string): GitOutcome {
    this.log.push(`checkout ${dir} ${branch}`);
    const checkout = this.checkouts.get(dir);
    if (this.checkoutFails === undefined && checkout !== undefined) {
      this.checkouts.set(dir, { ...checkout, branch });
    }
    return failed(this.checkoutFails);
  }

  fastForward(dir: string, to: string): GitOutcome {
    this.log.push(`fastForward ${dir} ${to}`);
    if (this.fastForwardFails === undefined) {
      this.heads.set(dir, to);
    }
    return failed(this.fastForwardFails);
  }

  resetTo(dir: string, to: string): GitOutcome {
    this.log.push(`resetTo ${dir} ${to}`);
    if (this.resetFails === undefined) {
      this.heads.set(dir, to);
    }
    return failed(this.resetFails);
  }
}
