import type { GitInvocation } from './invocations.ts';
import type { ShellWord } from './tokenizer.ts';

/**
 * What the guard knows of a repository's checked-out branch partway through a command line:
 * - `repo`: nothing changed it yet, so git can say;
 * - `branch` with target `read`: an existing branch was checked out, whose push target git can say;
 * - `branch` with target `same`: a new branch with no upstream, so a bare push targets the same name;
 * - `branch` with target `unknown`: the branch is known but where a bare push goes is not;
 * - `unknown`: the line changes the branch in a way the guard cannot follow.
 */
export type BranchView =
  | { readonly kind: 'repo' }
  | { readonly kind: 'branch'; readonly branch: string; readonly target: 'read' | 'same' | 'unknown' }
  | { readonly kind: 'unknown' };

const REPO: BranchView = { kind: 'repo' };
const UNKNOWN: BranchView = { kind: 'unknown' };

/** `checkout` / `switch` options that take a value as the next word. */
const CHECKOUT_VALUED: ReadonlySet<string> = new Set(['--conflict', '--pathspec-from-file']);
/** Options that create a branch, with the new name as their value. */
const CREATE_OPTIONS: ReadonlySet<string> = new Set(['-b', '-B', '-c', '-C', '--orphan', '--create', '--force-create']);
const BRANCH_RETARGETS: ReadonlySet<string> = new Set(['-m', '-M', '--move', '-u', '--set-upstream-to', '--unset-upstream']);
const CONFIG_READS: ReadonlySet<string> = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', 'get', 'list']);

/** The operands of a git command: words that are no option, before any `--`. */
function operands(args: readonly ShellWord[]): ShellWord[] {
  const found: ShellWord[] = [];
  for (const arg of args) {
    if (arg.text === '--') {
      break;
    }
    if (!arg.text.startsWith('-')) {
      found.push(arg);
    }
  }
  return found;
}

/**
 * Tracks branch changes within one command line, so `git checkout main && git push` is judged on `main`,
 * not on the branch checked out before the line ran. Views are per folder; a move in one folder makes every
 * other folder's view unknown, since the guard cannot tell whether they share a repository.
 */
export class BranchMoves {
  private readonly views = new Map<string, BranchView>();
  private othersUnknown = false;
  private readonly protectedBranches: ReadonlySet<string>;

  constructor(protectedBranches: ReadonlySet<string>) {
    this.protectedBranches = protectedBranches;
  }

  /** The view of the repository in `dir` at this point of the line. */
  view(dir: string): BranchView {
    return this.views.get(dir) ?? (this.othersUnknown ? UNKNOWN : REPO);
  }

  /** Updates the views after one git command runs. */
  observe(invocation: GitInvocation): void {
    const moved = this.moveOf(invocation);
    if (moved === undefined) {
      return;
    }
    for (const key of this.views.keys()) {
      this.views.set(key, UNKNOWN);
    }
    this.othersUnknown = true;
    if (invocation.dir !== undefined && moved !== 'everywhere') {
      this.views.set(invocation.dir, moved);
    }
  }

  /** How a command moves the branch of its folder; `everywhere` when it may move any repository's; undefined when it moves none. */
  private moveOf({ subcommand, args, dir }: GitInvocation): BranchView | 'everywhere' | undefined {
    const moved = this.localMove(subcommand, args);
    return moved !== undefined && dir === undefined ? 'everywhere' : moved;
  }

  private localMove(subcommand: string, args: readonly ShellWord[]): BranchView | 'everywhere' | undefined {
    const texts = args.map((arg) => arg.text);
    switch (subcommand) {
      case 'switch':
      case 'checkout':
        return this.checkout(subcommand, args);
      case 'branch':
        return texts.some((text) => BRANCH_RETARGETS.has(text.split('=')[0] ?? '')) ? UNKNOWN : undefined;
      case 'rebase':
        return operands(args).length >= 2 ? UNKNOWN : undefined;
      case 'bisect':
        return UNKNOWN;
      case 'config':
        return !texts.some((text) => CONFIG_READS.has(text)) && texts.some((text) => /^(?:remote|push|branch)\./i.test(text)) ? 'everywhere' : undefined;
      default:
        return undefined;
    }
  }

  /** `switch X`, `switch -c X [start]`, `checkout -b X [start]`, `checkout X`; a file checkout (`-p`, `--`, several operands) moves nothing. */
  private checkout(subcommand: string, args: readonly ShellWord[]): BranchView | undefined {
    const positional: ShellWord[] = [];
    let created: ShellWord | undefined;
    let tracked = false;
    let detached = false;
    let paths = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? { text: '', dynamic: false };
      const equals = arg.text.startsWith('--') ? arg.text.indexOf('=') : -1;
      const name = equals === -1 ? arg.text : arg.text.slice(0, equals);
      const attached = equals === -1 ? undefined : { text: arg.text.slice(equals + 1), dynamic: arg.dynamic };
      if (arg.text === '--' || name === '-p' || name === '--patch') {
        paths = true;
        break;
      }
      if (CREATE_OPTIONS.has(name) && (subcommand === 'switch' || !/^(?:-[cC]|--create|--force-create)$/.test(name))) {
        created = attached ?? args[(index += 1)];
      } else if (name === '-t' || name === '--track') {
        tracked = true;
      } else if (name === '-d' || name === '--detach' || name === '-') {
        detached = true;
      } else if (CHECKOUT_VALUED.has(name) && attached === undefined) {
        index += 1;
      } else if (!arg.text.startsWith('-')) {
        positional.push(arg);
      }
    }
    if (created !== undefined) {
      return created.dynamic ? UNKNOWN : { kind: 'branch', branch: created.text, target: tracked || positional.length > 0 ? 'unknown' : 'same' };
    }
    if (detached) {
      return UNKNOWN;
    }
    const [target, ...more] = positional;
    if (target === undefined || paths || more.length > 0) {
      return undefined;
    }
    if (target.dynamic) {
      return UNKNOWN;
    }
    // `checkout X` may restore a file named X instead; only a protected name is trusted as a branch.
    if (subcommand === 'checkout' && !this.protectedBranches.has(target.text)) {
      return UNKNOWN;
    }
    return { kind: 'branch', branch: target.text, target: tracked ? 'unknown' : 'read' };
  }
}

