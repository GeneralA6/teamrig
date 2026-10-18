import { staticWord } from '../push-guard/launchers.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import type { ProgramRun } from './programs.ts';

/**
 * What a package runner call does with the package it names. An ad-hoc runner fetches a package from the registry
 * and runs it at once, outside the project's lockfile and any vetting: `npx` or `npm exec` of a tool not
 * installed, `npm create` or `npm init <initializer>`, `pnpm dlx` (`pnpx`), `pnpm create`, `yarn dlx`,
 * `yarn create`, `bunx` (`bun x`) and `bun create`. `pnpm exec`, `yarn exec` and a script run only what is installed.
 */
export type RunnerCall =
  /** Not a package runner, or a call that runs only what is installed (`npx --no`, `npx ./tool.js`). */
  | { readonly kind: 'none' }
  /** Fetches the package it names: `pnpm dlx x`, `npm create x`, `npx -p x`, `npx x@1.2.3`. */
  | { readonly kind: 'fetch'; readonly call: string }
  /** Runs `bin` from `node_modules/.bin` when installed where it runs, else fetches a package of that name. */
  | { readonly kind: 'bin'; readonly call: string; readonly bin: string; readonly prefix: ShellWord | undefined };

const NONE: RunnerCall = { kind: 'none' };
const NO_FLAGS: ReadonlySet<string> = new Set();
/** A word only known when the line runs, for an option whose value is missing. */
const UNKNOWN_WORD: ShellWord = { text: '', dynamic: true };

/** npx's, npm exec's and bunx's options that take a value, so the word after one is not the command. */
export const EXEC_VALUED: ReadonlySet<string> = new Set(['-p', '--package', '-c', '--call', '--prefix', '-w', '--workspace', '--registry', '--cache', '--userconfig']);
/** npx's and npm exec's options that make it run an installed bin or fail, never fetch. */
const NPX_NO_FETCH: ReadonlySet<string> = new Set(['--no', '--no-install']);
/** npm's options before its subcommand that take a value. */
export const NPM_VALUED: ReadonlySet<string> = new Set(['--prefix', '-w', '--workspace', '--registry', '--cache', '--userconfig', '--loglevel']);
/** npm init's options that take a value, so the word after one is not the initializer. */
const NPM_INIT_VALUED: ReadonlySet<string> = new Set([...NPM_VALUED, '--scope', '--init-author-name', '--init-author-email', '--init-author-url', '--init-license', '--init-version', '--init-module']);
const PNPM_VALUED: ReadonlySet<string> = new Set(['-C', '--dir', '-F', '--filter']);
/** The options of pnpm dlx and yarn dlx that take a value. */
const DLX_VALUED: ReadonlySet<string> = new Set(['-p', '--package', '--allow-build']);
const YARN_VALUED: ReadonlySet<string> = new Set(['--cwd']);
const BUN_VALUED: ReadonlySet<string> = new Set(['--cwd', '-c', '--config']);

/** A command word that names a file to run, not a package: `./tool.js`, `../x`, `/opt/x`, `~/x`, `C:\x`. */
const FILE_PATH = /^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:[\\/])/;
/** A package spec other than a bare name: `name@1.2.3`, `@scope/name`, `github:user/repo`, `user/repo`. */
const PACKAGE_SPEC = /[@:/\\]/;

/** A runner's leading options, read up to the first word that is not one. */
interface Options {
  /** Every option given, by name (`--package` for `--package=x`). */
  readonly flags: ReadonlySet<string>;
  /** The value of each valued option given. */
  readonly values: ReadonlyMap<string, ShellWord>;
  /** The words after the options: the command or the subcommand first. */
  readonly rest: readonly ShellWord[];
}

/** Reads leading options; `--` ends them, and a word only known when the line runs is the first that is not one. */
function readOptions(args: readonly ShellWord[], valued: ReadonlySet<string>): Options {
  const flags = new Set<string>();
  const values = new Map<string, ShellWord>();
  let index = 0;
  while (index < args.length) {
    const word = args[index] ?? UNKNOWN_WORD;
    if (word.dynamic || !word.text.startsWith('-')) {
      break;
    }
    index += 1;
    if (word.text === '--') {
      break;
    }
    const equals = word.text.startsWith('--') ? word.text.indexOf('=') : -1;
    const name = equals === -1 ? word.text : word.text.slice(0, equals);
    flags.add(name);
    if (equals !== -1) {
      values.set(name, staticWord(word.text.slice(equals + 1)));
    } else if (valued.has(name)) {
      values.set(name, args[index] ?? UNKNOWN_WORD);
      index += 1;
    }
  }
  return { flags, values, rest: args.slice(index) };
}

/** The value of the first of `names` given. */
function valueOf(options: Options, ...names: readonly string[]): ShellWord | undefined {
  return names.map((name) => options.values.get(name)).find((value) => value !== undefined);
}

/** How a call shows in a refusal: the runner and the package it names. */
function callText(runner: string, target: ShellWord): string {
  return `${runner} ${target.dynamic ? '<a value only known when it runs>' : target.text}`;
}

/** `npx`, `npm exec` and `bunx`: a bare name runs an installed bin or fetches; a package option or a spec fetches. */
function execCall(runner: string, args: readonly ShellWord[], noFetch: ReadonlySet<string>, outerPrefix: ShellWord | undefined): RunnerCall {
  const options = readOptions(args, EXEC_VALUED);
  if ([...options.flags].some((flag) => noFetch.has(flag))) {
    return NONE;
  }
  const pkg = valueOf(options, '-p', '--package');
  if (pkg !== undefined) {
    return { kind: 'fetch', call: callText(`${runner} --package`, pkg) };
  }
  // `-c` runs a shell line with the installed bins on PATH; without a package option it fetches nothing.
  const [command] = options.rest;
  if (options.flags.has('-c') || options.flags.has('--call') || command === undefined) {
    return NONE;
  }
  const call = callText(runner, command);
  if (command.dynamic || (PACKAGE_SPEC.test(command.text) && !FILE_PATH.test(command.text))) {
    return { kind: 'fetch', call };
  }
  if (FILE_PATH.test(command.text)) {
    return NONE;
  }
  return { kind: 'bin', call, bin: command.text, prefix: valueOf(options, '--prefix') ?? outerPrefix };
}

/** `npm create x`, `pnpm dlx x` and the like: each fetches the package its first word or its package option names. */
function fetchCall(runner: string, args: readonly ShellWord[], valued: ReadonlySet<string>): RunnerCall {
  const options = readOptions(args, valued);
  const pkg = valueOf(options, '-p', '--package');
  if (pkg !== undefined) {
    return { kind: 'fetch', call: callText(`${runner} --package`, pkg) };
  }
  const [target] = options.rest;
  return target === undefined ? NONE : { kind: 'fetch', call: callText(runner, target) };
}

/** A runner's subcommand, after its leading options, with the words after it. */
function subcommandOf(args: readonly ShellWord[], valued: ReadonlySet<string>): { readonly name: string | undefined; readonly rest: readonly ShellWord[]; readonly options: Options } {
  const options = readOptions(args, valued);
  const [head, ...rest] = options.rest;
  return { name: head === undefined || head.dynamic ? undefined : head.text, rest, options };
}

function npmCall(args: readonly ShellWord[]): RunnerCall {
  const { name, rest, options } = subcommandOf(args, NPM_VALUED);
  switch (name) {
    case 'exec':
    case 'x':
      return execCall('npm exec', rest, NPX_NO_FETCH, valueOf(options, '--prefix'));
    case 'create':
    case 'init':
    case 'innit':
      return fetchCall(`npm ${name}`, rest, NPM_INIT_VALUED);
    default:
      return NONE;
  }
}

function pnpmCall(args: readonly ShellWord[]): RunnerCall {
  const { name, rest } = subcommandOf(args, PNPM_VALUED);
  return name === 'dlx' || name === 'create' ? fetchCall(`pnpm ${name}`, rest, DLX_VALUED) : NONE;
}

function yarnCall(args: readonly ShellWord[]): RunnerCall {
  const { name, rest } = subcommandOf(args, YARN_VALUED);
  return name === 'dlx' || name === 'create' ? fetchCall(`yarn ${name}`, rest, DLX_VALUED) : NONE;
}

function bunCall(args: readonly ShellWord[]): RunnerCall {
  const { name, rest } = subcommandOf(args, BUN_VALUED);
  if (name === 'x') {
    return execCall('bun x', rest, NO_FLAGS, undefined);
  }
  return name === 'create' ? fetchCall('bun create', rest, NO_FLAGS) : NONE;
}

/** Each package runner by program name. */
const RUNNERS: ReadonlyMap<string, (args: readonly ShellWord[]) => RunnerCall> = new Map([
  ['npx', (args: readonly ShellWord[]) => execCall('npx', args, NPX_NO_FETCH, undefined)],
  ['npm', npmCall],
  ['pnpx', (args: readonly ShellWord[]) => fetchCall('pnpx', args, DLX_VALUED)],
  ['pnpm', pnpmCall],
  ['yarn', yarnCall],
  ['bunx', (args: readonly ShellWord[]) => execCall('bunx', args, NO_FLAGS, undefined)],
  ['bun', bunCall],
]);

/** What a program run does as a package runner; see {@link RunnerCall}. */
export function runnerCallOf(run: ProgramRun): RunnerCall {
  return RUNNERS.get(run.name)?.(run.args) ?? NONE;
}
