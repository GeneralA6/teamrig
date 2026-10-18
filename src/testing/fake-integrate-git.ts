import type { GitOutcome } from '../core/git-run.ts';
import type { Checkout, IntegrateGit, LocalUpdate } from '../integrate/git.ts';

/** The linked worktree a fake integrate runs in. */
export const WORKTREE = '/w/feat';
/** The main checkout that worktree belongs to. */
export const MAIN_CHECKOUT = '/repo/app';

const OK: GitOutcome = { ok: true };
const TRACKING = 'origin/';
const BRANCH_REF = 'refs/heads/';

function failed(reason: string | undefined): GitOutcome {
  return reason === undefined ? OK : { ok: false, reason };
}

/**
 * A repository for `teamrig integrate`, in memory. The branch `feat` is checked out at commit `mine` in the linked
 * worktree `/w/feat`; its main checkout `/repo/app` is on `main` at `base`, where origin's `main` is too. A fetch
 * copies origin's branches to `origin/<name>`, a rebase moves HEAD to `rebasedTo` on top of what it rebased onto, and
 * each step that touches git is logged in `log`. A test sets a `...Fails` field to make that step fail, calls
 * `pushed` where a push lands, or moves `origin` alone where another clone pushed.
 */
export class FakeIntegrateGit implements IntegrateGit {
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
  /** origin's branches as the last fetch copied them. */
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
  defaultName = 'main';
  mergeBaseIs: string | undefined = 'base';
  paths: readonly string[] | undefined = ['src/app.ts'];
  landed: readonly string[] = ['rebased'];
  rebasedTo = 'rebased';
  localUpdate: LocalUpdate = { kind: 'checkedOut' };
  fetchFails: string | undefined;
  rebaseFails: string | undefined;
  deleteRemoteFails: string | undefined;
  detachFails: string | undefined;
  checkoutFails: string | undefined;
  fastForwardFails: string | undefined;

  /** A push of ours lands: origin's branch moves, and so does its tracking ref, as git push moves both. */
  pushed(branch: string, commit: string): void {
    this.origin.set(branch, commit);
    this.tracking.set(branch, commit);
  }

  private commitOf(dir: string, ref: string): string | undefined {
    if (ref === 'HEAD') {
      return this.heads.get(dir);
    }
    if (ref.startsWith(TRACKING)) {
      return this.tracking.get(ref.slice(TRACKING.length));
    }
    if (ref.startsWith(BRANCH_REF)) {
      return this.branches.get(ref.slice(BRANCH_REF.length));
    }
    return ref;
  }

  checkoutOf(dir: string): Checkout | undefined {
    return this.checkouts.get(dir);
  }

  changes(dir: string, untracked: boolean): readonly string[] | undefined {
    if (this.statusFails.has(dir)) {
      return undefined;
    }
    return (this.status.get(dir) ?? []).filter((line) => untracked || !line.startsWith('??'));
  }

  fetch(dir: string): GitOutcome {
    this.log.push(`fetch ${dir}`);
    if (this.fetchFails === undefined) {
      this.tracking.clear();
      for (const [name, commit] of this.origin) {
        this.tracking.set(name, commit);
      }
    }
    return failed(this.fetchFails);
  }

  defaultBranch(): string {
    return this.defaultName;
  }

  sha(dir: string, ref: string): string | undefined {
    return this.commitOf(dir, ref);
  }

  remoteHead(_dir: string, branch: string): string | undefined {
    return this.origin.get(branch);
  }

  mergeBase(): string | undefined {
    return this.mergeBaseIs;
  }

  changedPaths(): readonly string[] | undefined {
    return this.paths;
  }

  fileAt(dir: string, ref: string, path: string): string | undefined {
    return this.files.get(`${this.commitOf(dir, ref) ?? ref}:${path}`);
  }

  commits(): readonly string[] {
    return this.landed;
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

  updateLocalBranch(dir: string, branch: string): LocalUpdate {
    this.log.push(`updateLocalBranch ${dir} ${branch}`);
    const commit = this.tracking.get(branch);
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
}
