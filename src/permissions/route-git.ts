import { branchTaskOf } from '../worktree/owner.ts';

/**
 * The git commands a sanctioned route may run (T679, security rulings C4 and C5), each read by an exact allowlist:
 * any option, global or spelling it does not name is no match, so a prefix git would take (`--no-veri`), `-n` in a
 * cluster, `-c`, `--git-dir` or `--exec-path` never matches. The program word is a bare `git`, placed by PATH as any
 * call's is.
 */

/** What a git route needs beyond the line's words; asked only once the rest of the line matches. */
export interface GitContext {
  /** True when the session asking owns the task; false for a task the register lacks, or a tab bound to no session. */
  readonly ownsTask: (task: string) => Promise<boolean>;
  /** True when `name` is a remote of the repository git reaches from the hook's folder through the line's `-C` folders, in order. */
  readonly isRemote: (folders: readonly string[], name: string) => Promise<boolean>;
  /**
   * True when git, in that same folder, pushes a branch named alone (`git push <remote> <branch>`) to the remote's
   * branch of that name. A `remote.<name>.push` refspec or a `push.default` of `upstream` or `tracking` maps it onto
   * another (git's map_refspec), such as the `origin/main` a worktree branch cut from it tracks.
   */
  readonly pushesToSameName: (folders: readonly string[], remote: string) => Promise<boolean>;
  readonly protectedBranches: readonly string[];
}

/** The line split at its git subcommand: the `-C` folders before it, and the words after it. */
interface GitLine {
  readonly folders: readonly string[];
  readonly args: readonly string[];
}

/** `git [-C <folder>]... <subcommand> <args>`, with no other global option; undefined for anything else. */
function gitLineOf(words: readonly string[], subcommand: string): GitLine | undefined {
  const [program, ...rest] = words;
  if (program !== 'git') {
    return undefined;
  }
  const folders: string[] = [];
  let at = 0;
  while (rest[at] === '-C') {
    const folder = rest[at + 1];
    if (folder === undefined || folder.startsWith('-')) {
      return undefined;
    }
    folders.push(folder);
    at += 2;
  }
  return rest[at] === subcommand ? { folders, args: rest.slice(at + 1) } : undefined;
}

/** `git commit`'s short options that take no value. */
const COMMIT_FLAGS = new Set(['a', 's', 'q']);

/** `git commit`'s short options that take the next word: the message, or the file it is read from. */
const COMMIT_VALUES = new Set(['m', 'F']);

/** `git commit`'s long options that take no value. */
const COMMIT_LONG_FLAGS = new Set(['--all', '--signoff', '--quiet']);

/** `git commit`'s long options that take a value, as `--name value` or `--name=value`. */
const COMMIT_LONG_VALUES = new Set(['--message', '--file']);

/**
 * C4: `git commit` with only `-a -s -q -m -F` (in clusters, a value letter last), `--all --signoff --quiet --message
 * --file`, and pathspecs. Git permutes options and pathspecs, and `--` ends the options.
 */
export function matchesGitCommit(words: readonly string[]): boolean {
  const line = gitLineOf(words, 'commit');
  if (line === undefined) {
    return false;
  }
  const { args } = line;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? '';
    if (word === '--') {
      return true;
    }
    if (!word.startsWith('-')) {
      continue;
    }
    const taken = commitOptionTakes(word);
    if (taken === undefined || (taken && !isValue(args[at + 1]))) {
      return false;
    }
    at += taken ? 1 : 0;
  }
  return true;
}

/** Whether a commit option takes the next word; undefined for one off the allowlist. */
function commitOptionTakes(word: string): boolean | undefined {
  if (word.startsWith('--')) {
    const [name = '', value] = splitLong(word);
    if (COMMIT_LONG_FLAGS.has(name) && value === undefined) {
      return false;
    }
    if (COMMIT_LONG_VALUES.has(name)) {
      return value === undefined;
    }
    return undefined;
  }
  const letters = [...word.slice(1)];
  const last = letters.at(-1);
  if (last === undefined || !letters.slice(0, -1).every((letter) => COMMIT_FLAGS.has(letter))) {
    return undefined;
  }
  return COMMIT_VALUES.has(last) ? true : COMMIT_FLAGS.has(last) ? false : undefined;
}

/** `--name=value` as its name and value; a long option written alone has no value. */
function splitLong(word: string): readonly [string, string | undefined] {
  const equals = word.indexOf('=');
  return equals === -1 ? [word, undefined] : [word.slice(0, equals), word.slice(equals + 1)];
}

/** A value word an option takes: present, and not one git could read as an option of its own. */
function isValue(word: string | undefined): boolean {
  return word !== undefined && !word.startsWith('-');
}

/** `git push`'s short options; a cluster of them is one word. */
const PUSH_FLAGS = new Set(['u', 'q']);

/** `git push`'s long options. */
const PUSH_LONG_FLAGS = new Set(['--set-upstream', '--quiet']);

/** A remote name: no URL, path or transport such as `ext::`. */
const REMOTE_NAME = /^[\w.-]+$/;

/** A branch name: no refspec (`:`, `+`), no `refs/` path, no range; checked further in {@link isOwnBranch}. */
const BRANCH_NAME = /^[\w./-]+$/;

/**
 * C5: `git push [-u|--set-upstream] [-q|--quiet] <remote> <branch>`, the remote one the repository names, the branch
 * one of a task the caller owns (`t<id>-...`, or `feat/t<id>-...` with the id starting a part: owner.ts `branchTaskOf`)
 * and no protected branch, and git's config pushing it to the remote
 * branch of its own name (else a protected branch could be where it lands).
 */
export async function matchesGitPush(words: readonly string[], context: GitContext): Promise<boolean> {
  const line = gitLineOf(words, 'push');
  if (line === undefined) {
    return false;
  }
  const options = line.args.filter((word) => word.startsWith('-'));
  if (!options.every(isPushOption)) {
    return false;
  }
  const [remote, branch, ...more] = line.args.filter((word) => !word.startsWith('-'));
  const task = branch === undefined ? undefined : taskBranchOf(branch, context.protectedBranches);
  if (remote === undefined || task === undefined || more.length > 0 || !REMOTE_NAME.test(remote)) {
    return false;
  }
  return (await context.ownsTask(task)) && (await context.isRemote(line.folders, remote)) && context.pushesToSameName(line.folders, remote);
}

function isPushOption(word: string): boolean {
  if (word.startsWith('--')) {
    return PUSH_LONG_FLAGS.has(word);
  }
  const letters = [...word.slice(1)];
  return letters.length > 0 && letters.every((letter) => PUSH_FLAGS.has(letter));
}

/** The task of a plain task branch (`t<id>-...`, `feat/t<id>-...`) that is no protected branch, whatever its case; else undefined. */
function taskBranchOf(branch: string, protectedBranches: readonly string[]): string | undefined {
  const plain = BRANCH_NAME.test(branch) && !branch.includes('..') && !branch.toLowerCase().startsWith('refs/') && branch.toLowerCase() !== 'head';
  const unprotected = !protectedBranches.some((name) => name.toLowerCase() === branch.toLowerCase());
  return plain && unprotected ? branchTaskOf(branch) : undefined;
}
