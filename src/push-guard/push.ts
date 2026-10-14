import { join, resolve } from 'node:path';
import { splitCommands, stripHeredocs, type ShellDialect } from './shell.ts';

/** `allow` emits nothing, so Claude Code's normal permission flow decides. */
export type PushDecision = 'allow' | 'ask' | 'deny';

interface PushFlags {
  force: boolean;
  delete: boolean;
  dryRun: boolean;
  all: boolean;
  mirror: boolean;
}

/** One `git push` invocation: where it runs, its flags, and its remote and refspecs. */
export interface PushCommand extends Readonly<PushFlags> {
  readonly dir: string;
  readonly positionals: readonly string[];
}

/** What the guard asks a repository; the hook asks git, tests pass a fake. */
export interface RepoState {
  /** The checked-out branch in `dir`, or undefined when git cannot tell. */
  branch(dir: string): string | undefined;
  /** The remote branch a bare `git push` in `dir` updates, such as `origin/main`, if any. */
  pushTarget(dir: string): string | undefined;
}

export interface GuardContext {
  readonly cwd: string;
  /** The user's home folder, for `cd ~`. */
  readonly home: string;
  readonly dialect: ShellDialect;
  readonly protectedBranches: readonly string[];
  readonly repo: RepoState;
}

/** A protected branch a push updates: the commits of `source` not yet on `base` are what it sends. */
export interface ProtectedUpdate {
  readonly dir: string;
  /** The branch's remote-tracking ref as last fetched, such as `origin/main`. */
  readonly base: string;
  /** The local ref the push sends, such as `HEAD` or `feature`. */
  readonly source: string;
}

/** The decision on a whole command line, with the protected updates behind an `ask`. */
export interface PushVerdict {
  readonly decision: PushDecision;
  /** Empty unless the decision is `ask`; `--all` lists none, since what it sends depends on the remote. */
  readonly updates: readonly ProtectedUpdate[];
}

const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const CD_COMMANDS = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);
/** `--force-with-lease` is deliberately absent: a leased push to a protected branch only asks. */
const LONG_FLAGS = new Map<string, keyof PushFlags>([
  ['--force', 'force'],
  ['--delete', 'delete'],
  ['--dry-run', 'dryRun'],
  ['--all', 'all'],
  ['--branches', 'all'],
  ['--mirror', 'mirror'],
]);
const SHORT_FLAGS = new Map<string, keyof PushFlags>([
  ['f', 'force'],
  ['d', 'delete'],
  ['n', 'dryRun'],
]);

const isGit = (word: string): boolean => /(^|[\\/])git(\.exe)?$/i.test(word);
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** Resolves a `cd` target against the current folder; `~` is the home folder and `-` is ignored. */
export function resolveDir(current: string, target: string | undefined, home: string): string {
  if (target === undefined || target === '' || target === '-') {
    return current;
  }
  const expanded = target === '~' || target.startsWith('~/') ? join(home, target.slice(1)) : target;
  return resolve(current, expanded);
}

/** Reads one simple command; undefined unless it is a `git push`. */
export function parsePush(words: readonly string[], cwd: string, home: string): PushCommand | undefined {
  let index = 0;
  while (isAssignment(words[index] ?? '')) {
    index += 1;
  }
  if (!isGit(words[index] ?? '')) {
    return undefined;
  }
  index += 1;
  let dir = cwd;
  while ((words[index] ?? '').startsWith('-')) {
    const option = words[index] ?? '';
    if (option === '-C') {
      dir = resolveDir(dir, words[index + 1], home);
    }
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  if (words[index] !== 'push') {
    return undefined;
  }
  const flags: PushFlags = { force: false, delete: false, dryRun: false, all: false, mirror: false };
  const positionals: string[] = [];
  let endOfOptions = false;
  for (index += 1; index < words.length; index += 1) {
    const arg = words[index] ?? '';
    if (endOfOptions || !arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
    } else if (arg === '--') {
      endOfOptions = true;
    } else if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
    } else if (arg.startsWith('--')) {
      const flag = LONG_FLAGS.get(arg.split('=')[0] ?? '');
      if (flag !== undefined) {
        flags[flag] = true;
      }
    } else {
      for (const letter of arg.slice(1)) {
        const flag = SHORT_FLAGS.get(letter);
        if (flag !== undefined) {
          flags[flag] = true;
        }
      }
    }
  }
  return { dir, ...flags, positionals };
}

/** Strips `refs/heads/` and a remote-tracking prefix such as `refs/remotes/origin/`. */
function branchName(ref: string | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
}

interface Refspec {
  /** `+` forces this one update. */
  readonly plus: boolean;
  /** Empty for a deletion (`:branch`). */
  readonly source: string;
  readonly destination: string;
}

function readRefspec(refspec: string): Refspec {
  const plus = refspec.startsWith('+');
  const spec = plus ? refspec.slice(1) : refspec;
  const colon = spec.indexOf(':');
  return { plus, source: colon === -1 ? spec : spec.slice(0, colon), destination: colon === -1 ? spec : spec.slice(colon + 1) };
}

/** The remote branch a push with no refspec updates: its push target, else the branch of the same name. */
function bareTarget(push: PushCommand, repo: RepoState): string | undefined {
  const pushTarget = repo.pushTarget(push.dir);
  return pushTarget === undefined ? repo.branch(push.dir) : pushTarget.replace(/^[^/]+\//, '');
}

/** The branch a refspec destination names; `HEAD` is the checked-out branch. */
function destinationBranch(destination: string, push: PushCommand, repo: RepoState): string {
  return branchName(destination === 'HEAD' ? repo.branch(push.dir) : destination);
}

/** Decides one push: deny a force, mirror or delete of a protected branch, ask before any other push to one. */
export function judgePush(push: PushCommand, repo: RepoState, protectedBranches: ReadonlySet<string>): PushDecision {
  if (push.dryRun) {
    return 'allow';
  }
  if (push.mirror) {
    return 'deny';
  }
  if (push.all) {
    return push.force ? 'deny' : 'ask';
  }
  const isProtected = (ref: string | undefined): boolean => protectedBranches.has(branchName(ref));
  const refspecs = push.positionals.slice(1);
  if (refspecs.length === 0) {
    if (!isProtected(bareTarget(push, repo))) {
      return 'allow';
    }
    return push.force ? 'deny' : 'ask';
  }
  let decision: PushDecision = 'allow';
  for (const { plus, source, destination } of refspecs.map(readRefspec)) {
    if (!protectedBranches.has(destinationBranch(destination, push, repo))) {
      continue;
    }
    if (plus || push.force || push.delete || source === '') {
      return 'deny';
    }
    decision = 'ask';
  }
  return decision;
}

/**
 * The protected branches a push updates, each with the ref it sends there, for a push the guard
 * asks about. `--all`, `--mirror` and a dry run list none.
 */
export function protectedUpdates(push: PushCommand, repo: RepoState, protectedBranches: ReadonlySet<string>): ProtectedUpdate[] {
  if (push.dryRun || push.mirror || push.all) {
    return [];
  }
  const [remote, ...refspecs] = push.positionals;
  if (refspecs.length === 0) {
    const target = branchName(bareTarget(push, repo));
    const via = remote ?? repo.pushTarget(push.dir)?.split('/')[0] ?? 'origin';
    return protectedBranches.has(target) ? [{ dir: push.dir, base: `${via}/${target}`, source: 'HEAD' }] : [];
  }
  return refspecs.map(readRefspec).flatMap(({ source, destination }) => {
    const target = destinationBranch(destination, push, repo);
    return source !== '' && protectedBranches.has(target) ? [{ dir: push.dir, base: `${remote ?? 'origin'}/${target}`, source }] : [];
  });
}

/**
 * Judges a whole Bash or PowerShell command line: the strictest decision among its real
 * `git push` commands, and for an `ask` what each asked push updates. Text in quotes, comments
 * and heredocs is never read as a command, and `cd`, `Set-Location` and `git -C` move the folder
 * a bare push is resolved in.
 */
export function evaluatePushes(command: string, context: GuardContext): PushVerdict {
  if (!/\bpush\b/.test(command)) {
    return { decision: 'allow', updates: [] };
  }
  const protectedBranches = new Set(context.protectedBranches);
  let dir = context.cwd;
  let decision: PushDecision = 'allow';
  const updates: ProtectedUpdate[] = [];
  for (const words of splitCommands(stripHeredocs(command), context.dialect)) {
    if (CD_COMMANDS.has((words[0] ?? '').toLowerCase())) {
      dir = resolveDir(dir, words.slice(1).find((word) => !word.startsWith('-')), context.home);
      continue;
    }
    const push = parsePush(words, dir, context.home);
    if (push === undefined) {
      continue;
    }
    const verdict = judgePush(push, context.repo, protectedBranches);
    if (verdict === 'deny') {
      return { decision: 'deny', updates: [] };
    }
    if (verdict === 'ask') {
      decision = 'ask';
      updates.push(...protectedUpdates(push, context.repo, protectedBranches));
    }
  }
  return { decision, updates };
}

/** Why the guard stopped a push, naming the team's protected branches. */
export function decisionReason(decision: Exclude<PushDecision, 'allow'>, protectedBranches: readonly string[]): string {
  const branches = protectedBranches.join(', ');
  return decision === 'deny'
    ? `Force-pushing, mirroring or deleting a protected branch (${branches}) is refused: it can overwrite other sessions' commits. Push your own branch, or use --force-with-lease if you truly mean it.`
    : `This push updates a protected branch (${branches}) while other sessions may be working. Confirm, or push your own branch and rebase it onto the current one.`;
}
