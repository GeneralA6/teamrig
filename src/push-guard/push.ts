import type { PushToProtected } from '../config/types.ts';
import { BranchMoves, type BranchView } from './branch-moves.ts';
import { findGitInvocations, type FinderContext, type GitConfigReader, type GitInvocation, type GitInvocations } from './invocations.ts';
import { namedPushTarget, type MapChange, type NamedPushTarget } from './named-push.ts';
import type { ShellDialect, ShellWord } from './tokenizer.ts';

/** `allow` emits nothing, so Claude Code's normal permission flow decides. */
export type PushDecision = 'allow' | 'ask' | 'deny';

interface PushFlags {
  force: boolean;
  /** `--force-with-lease`: a forced push that first checks the remote branch is where the pusher last saw it. */
  leased: boolean;
  delete: boolean;
  dryRun: boolean;
  all: boolean;
  mirror: boolean;
  prune: boolean;
  help: boolean;
}

/** One push (`git push`, `git send-pack`, `git http-push`, `git subtree push`): where it runs, its flags, its remote and refspecs. */
export interface PushCommand extends Readonly<PushFlags> {
  /** Undefined when the folder is only known when the line runs. */
  readonly dir: string | undefined;
  readonly remote: ShellWord | undefined;
  readonly refspecs: readonly ShellWord[];
  /** True when `-c`, `--config-env` or a `GIT_CONFIG*` variable may change where a bare push goes. */
  readonly configOverride: boolean;
  /** True for a `send-pack` or `http-push` with no refs, which pushes the matching branches. */
  readonly matching: boolean;
  /**
   * True for `git push`, which sends a branch named alone where its config maps it (see `namedPushTarget`);
   * `send-pack`, `http-push` and `subtree push` send it to its own name.
   */
  readonly mapsNamed: boolean;
}

/** What the guard asks a repository; the hook asks git, tests pass a fake. */
export interface RepoState extends GitConfigReader {
  /** The checked-out branch in `dir`, or undefined when git cannot tell. */
  branch(dir: string): string | undefined;
  /** The short id of the commit checked out in `dir`, or undefined when git cannot tell (no repository, no commit yet). */
  head(dir: string): string | undefined;
  /** The remote branch a bare `git push` of `branch` (by default the checked-out one) in `dir` updates, such as `origin/main`, if any. */
  pushTarget(dir: string, branch?: string): string | undefined;
}

export interface GuardContext {
  readonly cwd: string;
  /** The user's home folder, for `cd ~`. */
  readonly home: string;
  readonly dialect: ShellDialect;
  readonly protectedBranches: readonly string[];
  /**
   * What a normal push to a protected branch gets: `ask`, else the verdict allows it and marks it `protectedPush`; under
   * `lead` the hook then decides whether the session may push (push-guard.ts).
   */
  readonly pushToProtected: PushToProtected;
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

/** A readable push to a protected branch: `normal`, or `leased` when it uses `--force-with-lease`. */
export type ProtectedPush = 'normal' | 'leased';

/** The decision on a whole command line, with the protected updates its pushes send. */
export interface PushVerdict {
  readonly decision: PushDecision;
  /**
   * What the line's readable pushes to a protected branch send; empty when it has none or is refused. `--all`, a
   * matching push and a push the guard cannot read add none, since what they send is not known.
   */
  readonly updates: readonly ProtectedUpdate[];
  /**
   * Set when the line pushes to a protected branch with neither a refusal nor a doubt: the decision is then `ask`,
   * or `allow` for a `normal` push under `pushToProtected: allow`, `lead` or `gated`. A `leased` push always asks.
   */
  readonly protectedPush?: ProtectedPush;
  /** Set only when the guard asks because it cannot read part of the line with confidence: why, as {@link doubtReason} words it. */
  readonly doubt?: string;
}

/** `git push` long options, so an abbreviation (`--dry`, `--mirr`) reads as git reads it. */
const PUSH_LONG_OPTIONS: readonly string[] = [
  'all', 'branches', 'mirror', 'delete', 'tags', 'dry-run', 'porcelain', 'force', 'force-with-lease', 'force-if-includes', 'repo',
  'set-upstream', 'thin', 'receive-pack', 'exec', 'progress', 'prune', 'no-verify', 'verify', 'follow-tags', 'signed', 'atomic',
  'push-option', 'ipv4', 'ipv6', 'recurse-submodules', 'quiet', 'verbose', 'help',
];
/** Long options whose value may be the next word. */
const PUSH_VALUED: ReadonlySet<string> = new Set(['repo', 'receive-pack', 'exec', 'push-option']);
/** `--force-with-lease` reads as `leased`, not `force`: a leased push to a protected branch asks rather than being refused. */
const LONG_FLAGS: ReadonlyMap<string, keyof PushFlags> = new Map<string, keyof PushFlags>([
  ['force', 'force'],
  ['force-with-lease', 'leased'],
  ['delete', 'delete'],
  ['dry-run', 'dryRun'],
  ['all', 'all'],
  ['branches', 'all'],
  ['mirror', 'mirror'],
  ['prune', 'prune'],
  ['help', 'help'],
]);
const SHORT_FLAGS: ReadonlyMap<string, keyof PushFlags> = new Map<string, keyof PushFlags>([
  ['f', 'force'],
  ['d', 'delete'],
  ['n', 'dryRun'],
  ['h', 'help'],
]);
const SEND_PACK_FLAGS: ReadonlyMap<string, keyof PushFlags> = new Map<string, keyof PushFlags>([
  ['--all', 'all'],
  ['--force', 'force'],
  ['--dry-run', 'dryRun'],
  ['--mirror', 'mirror'],
]);
/** `git subtree` options whose value may be the next word. */
const SUBTREE_VALUED: ReadonlySet<string> = new Set(['-P', '--prefix', '-m', '--message', '-b', '--branch', '--onto']);
/** The ways to name the checked-out branch inside `$( )` or backticks, which read as `HEAD`. */
const CURRENT_BRANCH_QUERY = String.raw`\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+(?:-q\s+)?--short\s+(?:-q\s+)?HEAD)\s*`;
const CURRENT_BRANCH = new RegExp(String.raw`\$\(${CURRENT_BRANCH_QUERY}\)|` + '`' + CURRENT_BRANCH_QUERY + '`', 'g');

const NO_FLAGS: PushFlags = { force: false, leased: false, delete: false, dryRun: false, all: false, mirror: false, prune: false, help: false };
const NO_WORD: ShellWord = { text: '', dynamic: false };

/** The long option a word names, as git's option parser reads an unambiguous abbreviation; `negated` for `--no-x`. */
function longOption(name: string): { readonly option: string; readonly negated: boolean } | undefined {
  const match = (candidate: string): string | undefined => {
    if (PUSH_LONG_OPTIONS.includes(candidate)) {
      return candidate;
    }
    const found = PUSH_LONG_OPTIONS.filter((option) => option.startsWith(candidate));
    return found.length === 1 ? found[0] : undefined;
  };
  const direct = match(name);
  if (direct !== undefined) {
    return { option: direct, negated: false };
  }
  const negated = name.startsWith('no-') ? match(name.slice(3)) : undefined;
  return negated === undefined ? undefined : { option: negated, negated: true };
}

function readPushArgs(invocation: GitInvocation): PushCommand {
  const { args } = invocation;
  const flags: PushFlags = { ...NO_FLAGS };
  const positionals: ShellWord[] = [];
  let endOfOptions = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? NO_WORD;
    const text = arg.text;
    if (endOfOptions || arg.dynamic || !text.startsWith('-') || text === '-') {
      positionals.push(arg);
    } else if (text === '--') {
      endOfOptions = true;
    } else if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      const named = longOption(equals === -1 ? text.slice(2) : text.slice(2, equals));
      if (named !== undefined && !named.negated && PUSH_VALUED.has(named.option) && equals === -1) {
        index += 1;
      }
      const flag = named === undefined ? undefined : LONG_FLAGS.get(named.option);
      if (named !== undefined && flag !== undefined) {
        flags[flag] = !named.negated;
      }
    } else {
      for (let at = 1; at < text.length; at += 1) {
        if (text.charAt(at) === 'o') {
          // -o takes a value: the rest of this word, else the next word.
          index += at + 1 === text.length ? 1 : 0;
          break;
        }
        const flag = SHORT_FLAGS.get(text.charAt(at));
        if (flag !== undefined) {
          flags[flag] = true;
        }
      }
    }
  }
  const [remote, ...refspecs] = positionals;
  return { dir: invocation.dir, ...flags, remote, refspecs, configOverride: invocation.configOverride, matching: false, mapsNamed: true };
}

/**
 * `git send-pack` and `git http-push`: `--all`, `--force`, `--force-with-lease[=…]`, `--mirror`, `--stdin`; with no refs
 * they push the matching branches.
 */
function readSendPack(invocation: GitInvocation): PushCommand {
  const flags: PushFlags = { ...NO_FLAGS };
  const positionals: ShellWord[] = [];
  let stdin = false;
  for (const arg of invocation.args) {
    const flag = arg.dynamic ? undefined : SEND_PACK_FLAGS.get(arg.text);
    if (flag !== undefined) {
      flags[flag] = true;
    } else if (!arg.dynamic && (arg.text === '--force-with-lease' || arg.text.startsWith('--force-with-lease='))) {
      flags.leased = true;
    } else if (arg.text === '--stdin') {
      stdin = true;
    } else if (arg.dynamic || !arg.text.startsWith('-')) {
      positionals.push(arg);
    }
  }
  const [remote, ...refs] = positionals;
  const refspecs = stdin ? [...refs, { text: '<stdin>', dynamic: true }] : refs;
  return { dir: invocation.dir, ...flags, remote, refspecs, configOverride: invocation.configOverride, matching: refspecs.length === 0, mapsNamed: false };
}

/** `git subtree push --prefix=<dir> <remote> <branch>`, which pushes a split history to `<branch>`. */
function readSubtreePush(invocation: GitInvocation): PushCommand | undefined {
  const operands: ShellWord[] = [];
  const { args } = invocation;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? NO_WORD;
    if (!arg.dynamic && arg.text.startsWith('-')) {
      index += SUBTREE_VALUED.has(arg.text) ? 1 : 0;
    } else {
      operands.push(arg);
    }
  }
  const [command, remote, branch] = operands;
  if (command?.text !== 'push' || branch === undefined) {
    return undefined;
  }
  return { dir: invocation.dir, ...NO_FLAGS, remote, refspecs: [branch], configOverride: invocation.configOverride, matching: false, mapsNamed: false };
}

/** Reads a git command as a push; undefined for any other command. */
export function parsePush(invocation: GitInvocation): PushCommand | undefined {
  switch (invocation.subcommand) {
    case 'push':
      return readPushArgs(invocation);
    case 'send-pack':
    case 'http-push':
      return readSendPack(invocation);
    case 'subtree':
      return readSubtreePush(invocation);
    default:
      return undefined;
  }
}

/** Strips `refs/heads/`, `heads/` and a remote-tracking prefix such as `refs/remotes/origin/`. */
function branchName(ref: string | undefined): string {
  return (ref ?? '').replace(/^(?:refs\/)?heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
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

/** A refspec only known when it runs reads as `HEAD` when it only names the checked-out branch; else undefined. */
function currentBranchIdiom(text: string): string | undefined {
  const replaced = text.replace(CURRENT_BRANCH, 'HEAD');
  return replaced !== text && !/[$`]/.test(replaced) ? replaced : undefined;
}

/** True when a destination, which may be a glob such as `*`, covers a protected branch. */
function coversProtected(destination: string, protectedBranches: ReadonlySet<string>): boolean {
  if (!destination.includes('*')) {
    return protectedBranches.has(destination);
  }
  const escaped = destination.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`^${escaped.join('.*')}$`);
  return [...protectedBranches].some((branch) => pattern.test(branch));
}

/** The decision on one push. */
interface Judgement {
  readonly decision: PushDecision;
  readonly updates: readonly ProtectedUpdate[];
  readonly doubt?: string;
}

const ALLOW: Judgement = { decision: 'allow', updates: [] };
const DENY: Judgement = { decision: 'deny', updates: [] };
const ASK_UNLISTED: Judgement = { decision: 'ask', updates: [] };
const askInDoubt = (doubt: string): Judgement => ({ decision: 'ask', updates: [], doubt });
/** A variable in the remote's place may hold several words (`$ARGS` = `origin main`), refspecs and force flags included. */
const DYNAMIC_REMOTE = 'its remote is only known when it runs, and may carry refspecs or flags';
/** `-c remote.<name>.push=...` or a GIT_CONFIG file can map a bare push, or a refspec with no `:<dst>`, onto any remote branch. */
const CONFIG_OVERRIDE = 'a -c option or GIT_CONFIG variable can change where it pushes';

/** The checked-out branch as the line's view sees it; `unknown` when the line moved it beyond reading. */
type CurrentBranch = { readonly kind: 'known'; readonly name: string | undefined } | { readonly kind: 'unknown' };

/** Judges one push: deny a force, mirror or delete of a protected branch, ask before any other push to one, and ask when in doubt. */
class PushJudge {
  private readonly repo: RepoState;
  private readonly protectedBranches: ReadonlySet<string>;

  constructor(repo: RepoState, protectedBranches: ReadonlySet<string>) {
    this.repo = repo;
    this.protectedBranches = protectedBranches;
  }

  /** `change`: what earlier commands in the line may have changed of where a branch named alone pushes. */
  judge(push: PushCommand, view: BranchView, change: MapChange): Judgement {
    if (push.help || push.dryRun) {
      return ALLOW;
    }
    if (push.mirror) {
      return DENY;
    }
    if (push.all || push.matching) {
      return push.force || push.prune ? DENY : ASK_UNLISTED;
    }
    if (push.refspecs.length > 0) {
      return this.explicit(push, view, change);
    }
    return push.dir === undefined ? askInDoubt('the folder it runs in is only known when it runs') : this.bare(push, push.dir, view);
  }

  private current(dir: string | undefined, view: BranchView): CurrentBranch {
    if (view.kind === 'branch') {
      return { kind: 'known', name: view.branch };
    }
    return view.kind === 'repo' && dir !== undefined ? { kind: 'known', name: this.repo.branch(dir) } : { kind: 'unknown' };
  }

  /** The local ref a push sends as `HEAD`, for listing its commits; undefined when that ref only exists once the line runs. */
  private headSource(view: BranchView): string | undefined {
    if (view.kind === 'repo') {
      return 'HEAD';
    }
    return view.kind === 'branch' && view.target === 'read' ? view.branch : undefined;
  }

  /** A push with no refspec: it updates the branch's push target, else the branch of the same name. */
  private bare(push: PushCommand, dir: string, view: BranchView): Judgement {
    if (push.remote?.dynamic === true) {
      return askInDoubt(DYNAMIC_REMOTE);
    }
    if (push.configOverride) {
      return askInDoubt(CONFIG_OVERRIDE);
    }
    const pushDefault = this.repo.config(dir, 'push.default');
    if (pushDefault.kind === 'set' && pushDefault.value.trim().toLowerCase() === 'matching') {
      return push.force || push.prune ? DENY : ASK_UNLISTED;
    }
    if (view.kind === 'unknown' || (view.kind === 'branch' && view.target === 'unknown')) {
      return askInDoubt('an earlier command in the line changes the branch or its upstream');
    }
    const pushTarget = view.kind === 'branch' && view.target === 'same' ? undefined : this.repo.pushTarget(dir, view.kind === 'branch' ? view.branch : undefined);
    const local = view.kind === 'branch' ? view.branch : this.repo.branch(dir);
    const target = branchName(pushTarget === undefined ? local : pushTarget.replace(/^[^/]+\//, ''));
    if (!this.protectedBranches.has(target)) {
      return ALLOW;
    }
    if (push.force) {
      return DENY;
    }
    const via = push.remote === undefined ? (pushTarget?.split('/')[0] ?? 'origin') : push.remote.dynamic ? undefined : push.remote.text;
    const source = this.headSource(view);
    return { decision: 'ask', updates: via === undefined || source === undefined ? [] : [{ dir, base: `${via}/${target}`, source }] };
  }

  /** A push with refspecs: each destination that is (or, as a glob, covers) a protected branch asks, or denies when forced or deleted. */
  private explicit(push: PushCommand, view: BranchView, change: MapChange): Judgement {
    let asked = false;
    let doubt: string | undefined = push.remote?.dynamic === true ? DYNAMIC_REMOTE : undefined;
    const updates: ProtectedUpdate[] = [];
    const remote = push.remote === undefined || push.remote.dynamic ? undefined : push.remote.text;
    for (let index = 0; index < push.refspecs.length; index += 1) {
      const word = push.refspecs[index] ?? NO_WORD;
      if (!word.dynamic && word.text === 'tag') {
        index += 1;
        continue;
      }
      const text = word.dynamic ? currentBranchIdiom(word.text) : word.text;
      if (text === undefined) {
        doubt ??= 'a refspec is only known when it runs';
        continue;
      }
      if (text === ':' || text === '+:') {
        // `:` pushes every branch the remote also has, protected ones included.
        if (push.force || push.prune || text.startsWith('+')) {
          return DENY;
        }
        asked = true;
        continue;
      }
      const { plus, source, destination } = readRefspec(text);
      const named = branchName(destination);
      const target = named === 'HEAD' || named === '@' ? this.current(push.dir, view) : { kind: 'known' as const, name: named };
      if (target.kind === 'unknown') {
        doubt ??= push.dir === undefined ? 'the folder it runs in is only known when it runs' : 'an earlier command in the line changes the branch HEAD names';
        continue;
      }
      const dest = branchName(target.name);
      // Git maps a branch named alone (no `:<dst>`, no `+`, not HEAD itself); the current-branch idiom names one when it runs.
      const alone = push.mapsNamed && !text.includes(':') && !plus && !push.delete && dest !== '' && !dest.includes('*') && (word.dynamic || dest === branchName(source));
      const mapped = alone ? this.namedTarget(push, dest, change) : { kind: 'to' as const, ref: dest };
      if (mapped.kind === 'doubt') {
        doubt ??= mapped.doubt;
        continue;
      }
      const branch = branchName(mapped.ref);
      if (!coversProtected(branch, this.protectedBranches)) {
        // A `-c` setting is read only when the line runs; keep the doubt for any refspec without its `:<dst>`.
        if (push.configOverride && !text.includes(':')) {
          doubt ??= CONFIG_OVERRIDE;
        }
        continue;
      }
      if (plus || push.force || push.delete || source === '' || (push.prune && branch.includes('*'))) {
        return DENY;
      }
      asked = true;
      const sent = source === 'HEAD' || source === '@' ? this.headSource(view) : source;
      if (push.dir !== undefined && !branch.includes('*') && remote !== undefined && sent !== undefined) {
        updates.push({ dir: push.dir, base: `${remote}/${branch}`, source: sent });
      }
    }
    if (asked) {
      return { decision: 'ask', updates };
    }
    return doubt === undefined ? ALLOW : askInDoubt(doubt);
  }

  /** Where a branch named alone lands: a name that is protected already asks, so only another one is mapped. */
  private namedTarget(push: PushCommand, branch: string, change: MapChange): NamedPushTarget {
    if (coversProtected(branch, this.protectedBranches)) {
      return { kind: 'to', ref: branch };
    }
    if (push.configOverride) {
      return { kind: 'doubt', doubt: CONFIG_OVERRIDE };
    }
    if (push.remote === undefined || push.remote.dynamic) {
      return { kind: 'doubt', doubt: DYNAMIC_REMOTE };
    }
    if (push.dir === undefined) {
      return { kind: 'doubt', doubt: 'the folder it runs in is only known when it runs' };
    }
    return namedPushTarget(this.repo, push.dir, push.remote.text, branch, change);
  }
}

/**
 * Judges a whole Bash or PowerShell command line: the strictest decision among the pushes it runs, and for an
 * `ask` what each asked push updates. The line is read as its shell would (see `findGitInvocations`): text in
 * quotes, comments and heredocs is never a command, `cd` and `git -C` move the folder, wrappers and nested
 * shells are seen through, and git aliases are expanded. A branch change earlier in the line (`git checkout
 * main && git push`) is followed (see `BranchMoves`). When part of the line cannot be read with confidence, the
 * guard asks: always for a push it cannot read, and for anything else it cannot read when the line says `push`.
 * With no protected branch there is nothing to guard, so every line is allowed, mirrors and doubts included.
 * Under `pushToProtected: allow`, `lead` or `gated` a normal push to a protected branch is allowed and marked; a refusal, a
 * leased push and a doubt are not changed by it.
 */
export function evaluatePushes(command: string, context: GuardContext): PushVerdict {
  if (context.protectedBranches.length === 0) {
    return { decision: 'allow', updates: [] };
  }
  return judgePushes(findGitInvocations(command, finderContextOf(context)), context);
}

/** How the guard's finder reads a line for `context`. */
export function finderContextOf(context: GuardContext): FinderContext {
  return { cwd: context.cwd, home: context.home, dialect: context.dialect, git: context.repo };
}

/** {@link evaluatePushes} for the git commands already found in a line, so a caller that also reads them finds them once. */
export function judgePushes(found: GitInvocations, context: GuardContext): PushVerdict {
  const protectedBranches = new Set(context.protectedBranches);
  if (protectedBranches.size === 0) {
    return { decision: 'allow', updates: [] };
  }
  const moves = new BranchMoves(protectedBranches);
  const judge = new PushJudge(context.repo, protectedBranches);
  let protectedPush: ProtectedPush | undefined;
  let doubt: string | undefined;
  const updates: ProtectedUpdate[] = [];
  for (const invocation of found.invocations) {
    const push = parsePush(invocation);
    if (push !== undefined) {
      const judgement = judge.judge(push, push.dir === undefined ? { kind: 'unknown' } : moves.view(push.dir), moves.mapChange());
      if (judgement.decision === 'deny') {
        return { decision: 'deny', updates: [] };
      }
      if (judgement.decision === 'ask' && judgement.doubt === undefined) {
        protectedPush = push.leased || protectedPush === 'leased' ? 'leased' : 'normal';
        updates.push(...judgement.updates);
      }
      doubt ??= judgement.doubt;
    }
    moves.observe(invocation);
  }
  if (protectedPush === 'leased' || (protectedPush === 'normal' && context.pushToProtected === 'ask')) {
    return { decision: 'ask', updates, protectedPush };
  }
  doubt ??= found.doubts.find((candidate) => !candidate.gated || found.mentionsPush)?.reason;
  if (doubt !== undefined) {
    return { decision: 'ask', updates, doubt };
  }
  return protectedPush === undefined ? { decision: 'allow', updates: [] } : { decision: 'allow', updates, protectedPush };
}

/** Why the guard stopped a push, naming the team's protected branches. */
export function decisionReason(decision: Exclude<PushDecision, 'allow'>, protectedBranches: readonly string[]): string {
  const branches = protectedBranches.join(', ');
  return decision === 'deny'
    ? `Force-pushing, mirroring or deleting a protected branch (${branches}) is refused: it can overwrite other sessions' commits. Push your own branch, or use --force-with-lease if you truly mean it.`
    : `This push updates a protected branch (${branches}) while other sessions may be working. Confirm, or push your own branch and rebase it onto the current one.`;
}

/** Why the guard asks about a `--force-with-lease` push to a protected branch, which no `pushToProtected` choice covers. */
export function leasedReason(protectedBranches: readonly string[]): string {
  return `This --force-with-lease push may rewrite the history of a protected branch (${protectedBranches.join(', ')}) while other sessions may be working. Confirm, or push your own branch instead.`;
}

/** Why the guard asks about a command line it cannot read with confidence, naming the team's protected branches. */
export function doubtReason(doubt: string, protectedBranches: readonly string[]): string {
  return `The guard cannot tell whether this command pushes to a protected branch (${protectedBranches.join(', ')}): ${doubt}. Confirm, or write the push out plainly.`;
}
