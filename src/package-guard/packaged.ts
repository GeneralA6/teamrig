import { type Assignment, isShell, programName, staticWord } from '../push-guard/launchers.ts';
import type { ShellDialect, ShellWord } from '../push-guard/tokenizer.ts';
import { BUN_VALUED, DLX_VALUED, EXEC_VALUED, NPM_VALUED, type Options, PNPM_VALUED, readOptions, subcommandOf, YARN_VALUED } from './runners.ts';

/**
 * What a package runner or a version manager starts besides itself (T3069): `bash -c "..."` in
 * `npx bash -c "..."`, the line npx's `-c` hands its shell, `teamrig ...` in `corepack pnpm exec teamrig ...`. Each
 * puts folders of its own first on the PATH (`node_modules/.bin`, a fetched package, a Node version's bin), so a bare
 * name it starts may find another program than the line's own shell would. The run collector (programs.ts) and the
 * push guard's reader visit what it starts as a command of their own, so no guard reading them is blind to it.
 */
export type PackagedStart =
  /** The words of the program it starts, read as a command of their own. */
  | { readonly kind: 'words'; readonly words: readonly ShellWord[] }
  /** A command line it hands a shell, in one dialect that shell may read it in (see {@link SCRIPT_DIALECTS}). */
  | { readonly kind: 'script'; readonly script: ShellWord; readonly dialect: ShellDialect }
  /**
   * A command line it hands a shell the line names (`--script-shell`, `npm_config_script_shell`, `ComSpec`) that is
   * no shell the guards read, or one only known when it runs, so no reading of the line is sure to be the one it runs.
   */
  | { readonly kind: 'foreign-shell'; readonly shell: ShellWord; readonly script: ShellWord };

/**
 * Every dialect a runner's shell line may run in. npm runs `-c` in its `script-shell`, set by `--script-shell`, by
 * `npm_config_script_shell`, by an `.npmrc` the line does not show, or else `ComSpec` on Windows; pnpm's shell mode
 * runs in `ComSpec` or `sh`. The line alone never settles the shell, so each reading is visited.
 */
const SCRIPT_DIALECTS: readonly ShellDialect[] = ['bash', 'cmd', 'powershell'];
/** The variables that pick a runner's shell: npm's `script-shell` in any case, and Windows' command processor. */
const SHELL_VARIABLE = /^(?:npm_config_script[-_]shell|comspec)$/i;

const NO_VALUES: ReadonlySet<string> = new Set();
/** The package managers corepack runs, by the name before an `@version`. */
const COREPACK_TOOLS: ReadonlySet<string> = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg']);
/** `volta run`'s options that take a value. */
const VOLTA_VALUED: ReadonlySet<string> = new Set(['--node', '--npm', '--pnpm', '--yarn', '--env']);
/** fnm's options before its subcommand that take a value. */
const FNM_VALUED: ReadonlySet<string> = new Set(['--node-dist-mirror', '--fnm-dir', '--log-level', '--arch', '--version-file-strategy']);
/** `fnm exec`'s options that take a value. */
const FNM_EXEC_VALUED: ReadonlySet<string> = new Set(['--using']);
/** The version `nvm exec` may take before the command: `20`, `v20.1.0`, `lts/iron`, `node`, `system`. */
const NVM_VERSION = /^(?:v?\d[\w.-]*|node|iojs|stable|unstable|system|default|lts\/\S+)$/;

function wordsOf(words: readonly ShellWord[]): readonly PackagedStart[] {
  return words.length === 0 ? [] : [{ kind: 'words', words }];
}

/** True for a program the guards read a command line of: a POSIX shell, PowerShell or cmd. */
function isScriptShell(word: ShellWord): boolean {
  return !word.dynamic && (isShell(word.text) || programName(word.text) === 'cmd');
}

/** `script` in each dialect it may run in, and once more for each shell the line names that the guards cannot read. */
function scriptOf(script: ShellWord, shells: readonly ShellWord[]): readonly PackagedStart[] {
  const foreign = shells.filter((shell) => !isScriptShell(shell)).map((shell): PackagedStart => ({ kind: 'foreign-shell', shell, script }));
  return [...SCRIPT_DIALECTS.map((dialect): PackagedStart => ({ kind: 'script', script, dialect })), ...foreign];
}

/** The shells the variables set for a runner name. */
function shellsSetBy(env: readonly Assignment[]): readonly ShellWord[] {
  return env.filter(({ name }) => SHELL_VARIABLE.test(name)).map(({ value }) => value);
}

/** `shells` with the one `--script-shell` names, if it is given. */
function withScriptShell(shells: readonly ShellWord[], options: Options): readonly ShellWord[] {
  const named = options.values.get('--script-shell');
  return named === undefined ? shells : [...shells, named];
}

/** The shells `npx`'s and `npm exec`'s own options or variables name, in force from the start of `args`. */
type NamedShells = readonly ShellWord[];

/** `npx`, `bunx`, `npm exec`, `bun x`: `-c`/`--call` hands its value to a shell, else the first operand is the program. */
function execStart(args: readonly ShellWord[], shells: NamedShells): readonly PackagedStart[] {
  const options = readOptions(args, EXEC_VALUED);
  const named = withScriptShell(shells, options);
  const call = options.values.get('-c') ?? options.values.get('--call');
  return call === undefined ? wordsOf(options.rest) : scriptOf(call, named);
}

/** `pnpm exec`, `pnpm dlx`, `pnpx`: `-c`/`--shell-mode` hands the words after the options to a shell, joined. */
function pnpmExecStart(args: readonly ShellWord[], valued: ReadonlySet<string>, shells: NamedShells): readonly PackagedStart[] {
  const options = readOptions(args, valued);
  const shellMode = options.flags.has('-c') || options.flags.has('--shell-mode');
  return shellMode && options.rest.length > 0 ? scriptOf(joined(options.rest), shells) : wordsOf(options.rest);
}

/** The words a shell mode joins into one command line, as pnpm joins them: with a space. */
function joined(words: readonly ShellWord[]): ShellWord {
  return { text: words.map((word) => word.text).join(' '), dynamic: words.some((word) => word.dynamic) };
}

/** A word that reads the same as a command line as it does as a program name: no space, quote or shell sign. */
const PLAIN_WORD = /^[\w.@/:+=,-]+$/;

/**
 * Yarn 2+'s `yarn exec` and Bun's `bun exec` run their first operand as a command line in a shell of their own
 * (Yarn's portable shell, Bun Shell), where Yarn 1's `yarn exec` runs it as a program: a word that is not plain is
 * read as a line too.
 */
function lineFirst(words: readonly ShellWord[]): readonly PackagedStart[] {
  const head = words[0];
  return head === undefined || (!head.dynamic && PLAIN_WORD.test(head.text)) ? [] : scriptOf(head, []);
}

/** The words when they start a shell (`sh -c "..."`), else nothing: a runner's bare form runs a bin by name, which the guards read by its words. */
function shellFirst(words: readonly ShellWord[]): readonly PackagedStart[] {
  const head = words[0];
  return head !== undefined && !head.dynamic && isShell(head.text) ? [{ kind: 'words', words }] : [];
}

/** `npm exec` and `npm x`, after npm's own options, any of which may name the script shell. */
function npmStart(args: readonly ShellWord[], shells: NamedShells): readonly PackagedStart[] {
  const { name, rest, options } = subcommandOf(args, NPM_VALUED);
  return name === 'exec' || name === 'x' ? execStart(rest, withScriptShell(shells, options)) : [];
}

function pnpmStart(args: readonly ShellWord[], shells: NamedShells): readonly PackagedStart[] {
  const { name, rest, options } = subcommandOf(args, PNPM_VALUED);
  switch (name) {
    case 'exec':
      return pnpmExecStart(rest, PNPM_VALUED, shells);
    case 'dlx':
      return pnpmExecStart(rest, DLX_VALUED, shells);
    default:
      return shellFirst(options.rest);
  }
}

function yarnStart(args: readonly ShellWord[]): readonly PackagedStart[] {
  const { name, rest, options } = subcommandOf(args, YARN_VALUED);
  switch (name) {
    case 'exec': {
      const words = readOptions(rest, NO_VALUES).rest;
      return [...wordsOf(words), ...lineFirst(words)];
    }
    case 'dlx':
      return wordsOf(readOptions(rest, DLX_VALUED).rest);
    case 'run':
      return shellFirst(readOptions(rest, NO_VALUES).rest);
    default:
      return shellFirst(options.rest);
  }
}

function bunStart(args: readonly ShellWord[], shells: NamedShells): readonly PackagedStart[] {
  const { name, rest, options } = subcommandOf(args, BUN_VALUED);
  switch (name) {
    case 'x':
      return execStart(rest, shells);
    case 'exec': {
      const words = readOptions(rest, NO_VALUES).rest;
      return [...wordsOf(words), ...lineFirst(words)];
    }
    case 'run':
      return shellFirst(readOptions(rest, BUN_VALUED).rest);
    default:
      return shellFirst(options.rest);
  }
}

/** `corepack <manager>[@<version>] ...`: the manager, read on as a command of its own. */
function corepackStart(args: readonly ShellWord[]): readonly PackagedStart[] {
  const { name, rest } = subcommandOf(args, NO_VALUES);
  const tool = name?.replace(/@.*$/, '');
  return tool === undefined || !COREPACK_TOOLS.has(tool) ? [] : [{ kind: 'words', words: [staticWord(tool), ...rest] }];
}

function voltaStart(args: readonly ShellWord[]): readonly PackagedStart[] {
  const { name, rest } = subcommandOf(args, NO_VALUES);
  return name === 'run' ? wordsOf(readOptions(rest, VOLTA_VALUED).rest) : [];
}

function fnmStart(args: readonly ShellWord[]): readonly PackagedStart[] {
  const { name, rest } = subcommandOf(args, FNM_VALUED);
  return name === 'exec' ? wordsOf(readOptions(rest, FNM_EXEC_VALUED).rest) : [];
}

/** `nvm exec [--silent] [<version>] <command>`: a first word that reads as a version is the version. */
function nvmStart(args: readonly ShellWord[]): readonly PackagedStart[] {
  const { name, rest } = subcommandOf(args, NO_VALUES);
  if (name !== 'exec') {
    return [];
  }
  const words = readOptions(rest, NO_VALUES).rest;
  const head = words[0];
  return wordsOf(head !== undefined && !head.dynamic && NVM_VERSION.test(head.text) ? words.slice(1) : words);
}

/** Each package runner and version manager by program name, given its arguments and the shells its variables name. */
const STARTS: ReadonlyMap<string, (args: readonly ShellWord[], shells: NamedShells) => readonly PackagedStart[]> = new Map([
  ['npx', execStart],
  ['bunx', execStart],
  ['npm', npmStart],
  ['pnpx', (args: readonly ShellWord[], shells: NamedShells) => pnpmExecStart(args, DLX_VALUED, shells)],
  ['pnpm', pnpmStart],
  ['yarn', yarnStart],
  ['bun', bunStart],
  ['corepack', corepackStart],
  ['volta', voltaStart],
  ['fnm', fnmStart],
  ['nvm', nvmStart],
]);

/** The package runners and version managers, by program name (`programName`). */
export const PACKAGE_STARTERS: ReadonlySet<string> = new Set(STARTS.keys());

/**
 * Every reading of what the program `name` starts with `args` and the variables `env` the line sets for it, besides
 * itself; empty when it is no package runner or starts nothing. A guard visits each one, so a line that runs one
 * way in one shell and another way in the next is held to all of them.
 */
export function packagedStartOf(name: string, args: readonly ShellWord[], env: readonly Assignment[]): readonly PackagedStart[] {
  return STARTS.get(name)?.(args, shellsSetBy(env)) ?? [];
}
