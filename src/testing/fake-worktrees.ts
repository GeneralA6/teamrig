import { basename, dirname, resolve } from 'node:path';
import type { EntryKind, TreeEntry, WorktreeFiles } from '../worktree/files.ts';
import type { GitOutcome, WorktreeEntry, WorktreeGit } from '../worktree/git.ts';
import type { WorktreePorts } from '../worktree/remove.ts';

/** One thing in a fake tree: a folder, a file, or a link (a symlink or a junction) to `target`. */
export type FakeNode = { readonly kind: 'folder' } | { readonly kind: 'file' } | { readonly kind: 'link'; readonly target: string };

/**
 * An in-memory tree for `WorktreeFiles`, keyed by resolved paths, so `/w/t/a`, a `join` of it and the absolute path
 * the CLI resolves name one node on every platform. A node's parent folders exist without being listed; the
 * canonical spelling of a path is its resolved one.
 */
export class FakeWorktreeFiles implements WorktreeFiles {
  private readonly nodes = new Map<string, FakeNode>();
  /** Each path unlinkLink was called with, in order. */
  readonly unlinked: string[] = [];
  /** Each link makeLink made, as `path -> target`, in order. */
  readonly linked: string[] = [];
  /** Links whose unlink leaves them in place, as a system that did not remove them would. */
  readonly stuck = new Set<string>();

  constructor(nodes: Readonly<Record<string, FakeNode>> = {}) {
    for (const [path, node] of Object.entries(nodes)) {
      this.put(path, node);
    }
  }

  put(path: string, node: FakeNode): void {
    const key = resolve(path);
    this.nodes.set(key, node);
    for (const parent of ancestry(key).slice(1)) {
      if (!this.nodes.has(parent)) {
        this.nodes.set(parent, { kind: 'folder' });
      }
    }
  }

  /** Deletes the node at `path` and everything under it, as git removing a worktree folder would. */
  delete(path: string): void {
    const key = resolve(path);
    for (const name of [...this.nodes.keys()]) {
      if (ancestry(name).includes(key)) {
        this.nodes.delete(name);
      }
    }
  }

  private children(dir: string): string[] {
    return [...this.nodes.keys()].filter((name) => name !== dir && dirname(name) === dir);
  }

  async entries(dir: string): Promise<readonly TreeEntry[]> {
    const key = resolve(dir);
    return this.children(key).map((name) => ({ name: basename(name), kind: kindOf(this.nodes.get(name)) }));
  }

  async kindOf(path: string): Promise<EntryKind | 'missing'> {
    const node = this.nodes.get(resolve(path));
    return node === undefined ? 'missing' : kindOf(node);
  }

  async linkTarget(path: string): Promise<string> {
    const node = this.nodes.get(resolve(path));
    if (node?.kind !== 'link') {
      throw new Error(`EINVAL: not a link: ${path}`);
    }
    return resolve(node.target);
  }

  async entryCount(path: string): Promise<number | undefined> {
    const key = resolve(path);
    const node = this.nodes.get(key);
    if (node?.kind === 'link') {
      return this.entryCount(node.target);
    }
    return node?.kind === 'folder' ? this.children(key).length : undefined;
  }

  async unlinkLink(path: string): Promise<void> {
    const key = resolve(path);
    if (this.nodes.get(key)?.kind !== 'link') {
      throw new Error(`EPERM: not a link: ${path}`);
    }
    this.unlinked.push(key);
    if (!this.stuck.has(key)) {
      this.nodes.delete(key);
    }
  }

  async makeLink(path: string, target: string): Promise<void> {
    const key = resolve(path);
    if (this.nodes.has(key)) {
      throw new Error(`EEXIST: file already exists: ${path}`);
    }
    if (this.nodes.get(dirname(key))?.kind !== 'folder') {
      throw new Error(`ENOENT: no such folder: ${dirname(path)}`);
    }
    this.nodes.set(key, { kind: 'link', target });
    this.linked.push(`${key} -> ${resolve(target)}`);
  }

  async canonical(path: string): Promise<string | undefined> {
    const key = resolve(path);
    return this.nodes.has(key) ? key : undefined;
  }
}

/** A path and each folder above it, up to its root. */
function ancestry(path: string): string[] {
  const chain = [path];
  for (let parent = dirname(path); parent !== chain.at(-1); parent = dirname(parent)) {
    chain.push(parent);
  }
  return chain;
}

function kindOf(node: FakeNode | undefined): EntryKind {
  return node?.kind === 'link' ? 'link' : node?.kind === 'folder' ? 'folder' : 'other';
}

/**
 * What a fake git answers; an answer left out or undefined reads as unknown, as a git that cannot tell, so a test
 * spreads `{ top: undefined }` over a world's answers to take one away. A removal, a branch delete, a fetch or a
 * worktree add left out succeeds.
 */
export interface FakeGitAnswers {
  readonly top?: string | undefined;
  readonly worktrees?: readonly WorktreeEntry[] | undefined;
  /** Every changed path; `changes` leaves out those at or under an excluded path. */
  readonly changes?: readonly string[] | undefined;
  /** Every tracked path; `tracked` returns those at or under an asked path. */
  readonly tracked?: readonly string[] | undefined;
  readonly defaultBase?: string | undefined;
  readonly commitsNotOn?: number | undefined;
  readonly headCommitsNotOn?: number | undefined;
  readonly removal?: GitOutcome;
  readonly deletion?: GitOutcome;
  /** Every local branch; `hasBranch` answers whether it lists the asked one. */
  readonly branches?: readonly string[] | undefined;
  readonly fetching?: GitOutcome;
  readonly adding?: GitOutcome;
}

/** A `WorktreeGit` with set answers, which records each step that would change something. */
export class FakeWorktreeGit implements WorktreeGit {
  /** The changing steps asked for, such as `worktree remove /w/t in /w/main`. */
  readonly steps: string[] = [];
  /** The paths each `changes` call left out. */
  readonly excluded: (readonly string[])[] = [];
  /** The base each `commitsNotOn` call compared with. */
  readonly bases: string[] = [];
  /** The base each `headCommitsNotOn` call compared with. */
  readonly headBases: string[] = [];

  private readonly answers: FakeGitAnswers;
  /** Runs after a removal that succeeds, such as deleting the worktree from a fake tree. */
  private readonly onRemove: () => void;

  constructor(answers: FakeGitAnswers = {}, onRemove: () => void = () => undefined) {
    this.answers = answers;
    this.onRemove = onRemove;
  }

  topOf(): string | undefined {
    return this.answers.top;
  }

  worktrees(): readonly WorktreeEntry[] | undefined {
    return this.answers.worktrees;
  }

  changes(_top: string, excluded: readonly string[]): readonly string[] | undefined {
    this.excluded.push(excluded);
    return this.answers.changes?.filter((path) => !excluded.some((name) => underOrAt(path, name)));
  }

  tracked(_top: string, paths: readonly string[]): readonly string[] | undefined {
    return this.answers.tracked?.filter((file) => paths.some((name) => underOrAt(file, name)));
  }

  defaultBase(): string | undefined {
    return this.answers.defaultBase;
  }

  commitsNotOn(_dir: string, _branch: string, base: string): number | undefined {
    this.bases.push(base);
    return this.answers.commitsNotOn;
  }

  headCommitsNotOn(_top: string, base: string): number | undefined {
    this.headBases.push(base);
    return this.answers.headCommitsNotOn;
  }

  removeWorktree(mainDir: string, top: string): GitOutcome {
    this.steps.push(`worktree remove ${top} in ${mainDir}`);
    const outcome = this.answers.removal ?? { ok: true };
    if (outcome.ok) {
      this.onRemove();
    }
    return outcome;
  }

  deleteBranch(mainDir: string, branch: string): GitOutcome {
    this.steps.push(`branch -D ${branch} in ${mainDir}`);
    return this.answers.deletion ?? { ok: true };
  }

  hasBranch(_dir: string, branch: string): boolean | undefined {
    return this.answers.branches?.includes(branch);
  }

  fetch(dir: string, remote: string, branch: string): GitOutcome {
    this.steps.push(`fetch ${remote} ${branch} in ${dir}`);
    return this.answers.fetching ?? { ok: true };
  }

  addWorktree(mainDir: string, path: string, branch: string, base: string): GitOutcome {
    this.steps.push(`worktree add -b ${branch} ${path} ${base} in ${mainDir}`);
    return this.answers.adding ?? { ok: true };
  }
}

function underOrAt(path: string, name: string): boolean {
  return path === name || path.startsWith(`${name}/`);
}

/** Worktree ports that see no worktree: no folder anywhere and a git that cannot answer. */
export function noWorktrees(): WorktreePorts {
  return { git: new FakeWorktreeGit(), files: new FakeWorktreeFiles() };
}
