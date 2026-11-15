import { isShell, SPAWN_SHELL, staticWord } from '../push-guard/launchers.ts';
import type { ShellDialect, ShellWord } from '../push-guard/tokenizer.ts';
import { BUN_VALUED, DLX_VALUED, EXEC_VALUED, NPM_VALUED, PNPM_VALUED, readOptions, subcommandOf, YARN_VALUED } from './runners.ts';

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
  /** A command line it hands a shell: npx's and npm exec's `-c`/`--call`, pnpm's `-c`/`--shell-mode`. */
  | { readonly kind: 'script'; readonly script: ShellWord; readonly dialect: ShellDialect };

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

function wordsOf(words: readonly ShellWord[]): PackagedStart | undefined {
  return words.length === 0 ? undefined : { kind: 'words', words };
}

function scriptOf(script: ShellWord): PackagedStart {
  return { kind: 'script', script, dialect: SPAWN_SHELL };
}

/** The words a shell mode joins into one command line, as pnpm joins them: with a space. */
function joined(words: readonly ShellWord[]): ShellWord {
  return { text: words.map((word) => word.text).join(' '), dynamic: words.some((word) => word.dynamic) };
}

/** The words when they start a shell (`sh -c "..."`), else undefined: a runner's bare form runs a bin by name, which the guards read by its words. */
function shellFirst(words: readonly ShellWord[]): PackagedStart | undefined {
  const head = words[0];
  return head !== undefined && !head.dynamic && isShell(head.text) ? { kind: 'words', words } : undefined;
}

/** `npx`, `bunx`, `npm exec`, `bun x`: `-c`/`--call` hands its value to a shell, else the first operand is the program. */
function execStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const options = readOptions(args, EXEC_VALUED);
  const call = options.values.get('-c') ?? options.values.get('--call');
  return call === undefined ? wordsOf(options.rest) : scriptOf(call);
}

/** `pnpm exec`, `pnpm dlx`, `pnpx`: `-c`/`--shell-mode` hands the words after the options to a shell, joined. */
function pnpmExecStart(args: readonly ShellWord[], valued: ReadonlySet<string>): PackagedStart | undefined {
  const options = readOptions(args, valued);
  const shellMode = options.flags.has('-c') || options.flags.has('--shell-mode');
  return shellMode && options.rest.length > 0 ? scriptOf(joined(options.rest)) : wordsOf(options.rest);
}

function npmStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest } = subcommandOf(args, NPM_VALUED);
  return name === 'exec' || name === 'x' ? execStart(rest) : undefined;
}

function pnpmStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest, options } = subcommandOf(args, PNPM_VALUED);
  switch (name) {
    case 'exec':
      return pnpmExecStart(rest, PNPM_VALUED);
    case 'dlx':
      return pnpmExecStart(rest, DLX_VALUED);
    default:
      return shellFirst(options.rest);
  }
}

function yarnStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest, options } = subcommandOf(args, YARN_VALUED);
  switch (name) {
    case 'exec':
      return wordsOf(readOptions(rest, NO_VALUES).rest);
    case 'dlx':
      return wordsOf(readOptions(rest, DLX_VALUED).rest);
    case 'run':
      return shellFirst(readOptions(rest, NO_VALUES).rest);
    default:
      return shellFirst(options.rest);
  }
}

function bunStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest, options } = subcommandOf(args, BUN_VALUED);
  switch (name) {
    case 'x':
      return execStart(rest);
    case 'run':
      return shellFirst(readOptions(rest, BUN_VALUED).rest);
    default:
      return shellFirst(options.rest);
  }
}

/** `corepack <manager>[@<version>] ...`: the manager, read on as a command of its own. */
function corepackStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest } = subcommandOf(args, NO_VALUES);
  const tool = name?.replace(/@.*$/, '');
  return tool === undefined || !COREPACK_TOOLS.has(tool) ? undefined : { kind: 'words', words: [staticWord(tool), ...rest] };
}

function voltaStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest } = subcommandOf(args, NO_VALUES);
  return name === 'run' ? wordsOf(readOptions(rest, VOLTA_VALUED).rest) : undefined;
}

function fnmStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest } = subcommandOf(args, FNM_VALUED);
  return name === 'exec' ? wordsOf(readOptions(rest, FNM_EXEC_VALUED).rest) : undefined;
}

/** `nvm exec [--silent] [<version>] <command>`: a first word that reads as a version is the version. */
function nvmStart(args: readonly ShellWord[]): PackagedStart | undefined {
  const { name, rest } = subcommandOf(args, NO_VALUES);
  if (name !== 'exec') {
    return undefined;
  }
  const words = readOptions(rest, NO_VALUES).rest;
  const head = words[0];
  return wordsOf(head !== undefined && !head.dynamic && NVM_VERSION.test(head.text) ? words.slice(1) : words);
}

/** Each package runner and version manager by program name. */
const STARTS: ReadonlyMap<string, (args: readonly ShellWord[]) => PackagedStart | undefined> = new Map([
  ['npx', execStart],
  ['bunx', execStart],
  ['npm', npmStart],
  ['pnpx', (args: readonly ShellWord[]) => pnpmExecStart(args, DLX_VALUED)],
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

/** What the program `name` starts with `args` besides itself, or undefined when it is no package runner or starts nothing. */
export function packagedStartOf(name: string, args: readonly ShellWord[]): PackagedStart | undefined {
  return STARTS.get(name)?.(args);
}
