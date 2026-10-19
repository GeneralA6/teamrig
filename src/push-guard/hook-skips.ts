import { configWrite, HOOKS_PATH_KEY, type GitInvocation } from './invocations.ts';
import type { ShellWord } from './tokenizer.ts';

/** A git command a line runs without the repository's hooks, and what in it turns them off, as written. */
export interface HookSkip {
  readonly dir: string | undefined;
  /** The git command, such as `commit`. */
  readonly subcommand: string;
  /** What turns the hooks off, such as `--no-verify`, `-n`, `HUSKY=0` or `-c core.hooksPath=/dev/null`. */
  readonly by: string;
}

/** How one hooked git command reads its options, so a value such as `-m "-n"` is never taken for a skip. */
interface OptionSpec {
  /** True where `-n` is `--no-verify` (commit, am); elsewhere it means something else (push's dry run, merge's no-stat). */
  readonly shortSkips: boolean;
  /** Short options that take a value: the rest of their cluster (`-mmsg`) or else the next word (`-m msg`). */
  readonly valuedShorts: string;
  /** Short options whose value, if any, is the rest of their cluster (`-S<key>`), never the next word. */
  readonly attachedShorts: string;
  /** Long options that take the next word as their value unless given with `=`. */
  readonly valuedLongs: ReadonlySet<string>;
}

function spec(shortSkips: boolean, valuedShorts: string, attachedShorts: string, valuedLongs: readonly string[]): OptionSpec {
  return { shortSkips, valuedShorts, attachedShorts, valuedLongs: new Set(valuedLongs.map((name) => `--${name}`)) };
}

/** The git commands that run hooks and take `--no-verify`, with how each reads its options. */
const HOOKED: ReadonlyMap<string, OptionSpec> = new Map([
  [
    'commit',
    spec(true, 'mFCct', 'uS', [
      'message',
      'file',
      'reuse-message',
      'reedit-message',
      'fixup',
      'squash',
      'author',
      'date',
      'template',
      'cleanup',
      'trailer',
      'pathspec-from-file',
    ]),
  ],
  ['push', spec(false, 'o', '', ['repo', 'receive-pack', 'exec', 'push-option'])],
  ['merge', spec(false, 'mFsX', 'S', ['message', 'file', 'strategy', 'strategy-option', 'into-name', 'cleanup'])],
  [
    'pull',
    spec(false, 'sXj', '', ['strategy', 'strategy-option', 'depth', 'deepen', 'shallow-since', 'shallow-exclude', 'upload-pack', 'jobs', 'negotiation-tip', 'server-option']),
  ],
  ['rebase', spec(false, 'sXxC', 'S', ['onto', 'strategy', 'strategy-option', 'exec', 'whitespace'])],
  ['am', spec(true, 'Cp', 'S', ['whitespace', 'directory', 'exclude', 'include', 'patch-format', 'resolvemsg', 'empty'])],
  ['send-email', spec(false, '', '', [])],
]);

const NO_VERIFY = '--no-verify';
/** The shortest `--no-verify` git takes: `--no-` alone names no option. */
const MIN_NO_VERIFY = '--no-v'.length;

/** True for `--no-verify` or an abbreviation git expands to it. */
function isNoVerify(name: string): boolean {
  return name.length >= MIN_NO_VERIFY && NO_VERIFY.startsWith(name);
}

/**
 * What in `args` turns the hooks off, read as `options` says: the last of `--no-verify` (or `-n`) and `--verify`
 * wins, a value is never an option, and `--` or `--end-of-options` ends the options. A word only known when it runs
 * is not read.
 */
function skipOption(args: readonly ShellWord[], options: OptionSpec): string | undefined {
  let skip: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined || word.text === '--' || word.text === '--end-of-options') {
      break;
    }
    const { text } = word;
    if (word.dynamic || !text.startsWith('-') || text === '-') {
      continue;
    }
    if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      const name = equals === -1 ? text : text.slice(0, equals);
      if (isNoVerify(name)) {
        skip = text;
      } else if (name === '--verify') {
        skip = undefined;
      } else if (equals === -1 && options.valuedLongs.has(name)) {
        index += 1;
      }
      continue;
    }
    for (let at = 1; at < text.length; at += 1) {
      const short = text.charAt(at);
      if (short === 'n' && options.shortSkips) {
        skip = '-n';
      } else if (options.valuedShorts.includes(short)) {
        index += at === text.length - 1 ? 1 : 0;
        break;
      } else if (options.attachedShorts.includes(short)) {
        break;
      }
    }
  }
  return skip;
}

/** What a `git config` invocation does to `core.hooksPath`, as written; undefined when it leaves the key alone. */
function hooksPathWrite(invocation: GitInvocation): string | undefined {
  const write = configWrite(invocation.args);
  if (write === undefined || write.key.dynamic || write.key.text.toLowerCase() !== HOOKS_PATH_KEY) {
    return undefined;
  }
  return write.kind === 'set' ? `git config ${write.key.text} ${write.value.text}` : `git config --unset ${write.key.text}`;
}

/** What turns one invocation's hooks off: an option, an override it inherits, or a `git config` of the hooks folder. */
function skipOf(invocation: GitInvocation): string | undefined {
  if (invocation.subcommand === 'config') {
    return hooksPathWrite(invocation);
  }
  const options = HOOKED.get(invocation.subcommand);
  if (options === undefined) {
    return undefined;
  }
  return skipOption(invocation.args, options) ?? invocation.hooksOverride;
}

/**
 * The git commands among `invocations` that run without the repository's hooks: a hooked command (commit, push,
 * merge, pull, rebase, am, send-email) given `--no-verify` (`-n` for commit and am) or run under a hooks override
 * (see `GitInvocation.hooksOverride`), and a `git config` that sets or unsets `core.hooksPath`, which moves every
 * later command off the hooks.
 */
export function hookSkips(invocations: readonly GitInvocation[]): HookSkip[] {
  return invocations.flatMap((invocation) => {
    const by = skipOf(invocation);
    return by === undefined ? [] : [{ dir: invocation.dir, subcommand: invocation.subcommand, by }];
  });
}
