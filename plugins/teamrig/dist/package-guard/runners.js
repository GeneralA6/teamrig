import { staticWord } from "../push-guard/launchers.js";
const NONE = { kind: 'none' };
const NO_FLAGS = new Set();
/** A word only known when the line runs, for an option whose value is missing. */
const UNKNOWN_WORD = { text: '', dynamic: true };
/** npx's, npm exec's and bunx's options that take a value, so the word after one is not the command. */
export const EXEC_VALUED = new Set(['-p', '--package', '-c', '--call', '--prefix', '-w', '--workspace', '--registry', '--cache', '--userconfig']);
/** npx's and npm exec's options that make it run an installed bin or fail, never fetch. */
const NPX_NO_FETCH = new Set(['--no', '--no-install']);
/** npm's options before its subcommand that take a value. */
export const NPM_VALUED = new Set(['--prefix', '-w', '--workspace', '--registry', '--cache', '--userconfig', '--loglevel']);
/** npm init's options that take a value, so the word after one is not the initializer. */
const NPM_INIT_VALUED = new Set([...NPM_VALUED, '--scope', '--init-author-name', '--init-author-email', '--init-author-url', '--init-license', '--init-version', '--init-module']);
const PNPM_VALUED = new Set(['-C', '--dir', '-F', '--filter']);
/** The options of pnpm dlx and yarn dlx that take a value. */
const DLX_VALUED = new Set(['-p', '--package', '--allow-build']);
const YARN_VALUED = new Set(['--cwd']);
const BUN_VALUED = new Set(['--cwd', '-c', '--config']);
/** A command word that names a file to run, not a package: `./tool.js`, `../x`, `/opt/x`, `~/x`, `C:\x`. */
const FILE_PATH = /^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:[\\/])/;
/** A package spec other than a bare name: `name@1.2.3`, `@scope/name`, `github:user/repo`, `user/repo`. */
const PACKAGE_SPEC = /[@:/\\]/;
/** Reads leading options; `--` ends them, and a word only known when the line runs is the first that is not one. */
function readOptions(args, valued) {
    const flags = new Set();
    const values = new Map();
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
        }
        else if (valued.has(name)) {
            values.set(name, args[index] ?? UNKNOWN_WORD);
            index += 1;
        }
    }
    return { flags, values, rest: args.slice(index) };
}
/** The value of the first of `names` given. */
function valueOf(options, ...names) {
    return names.map((name) => options.values.get(name)).find((value) => value !== undefined);
}
/** How a call shows in a refusal: the runner and the package it names. */
function callText(runner, target) {
    return `${runner} ${target.dynamic ? '<a value only known when it runs>' : target.text}`;
}
/** `npx`, `npm exec` and `bunx`: a bare name runs an installed bin or fetches; a package option or a spec fetches. */
function execCall(runner, args, noFetch, outerPrefix) {
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
function fetchCall(runner, args, valued) {
    const options = readOptions(args, valued);
    const pkg = valueOf(options, '-p', '--package');
    if (pkg !== undefined) {
        return { kind: 'fetch', call: callText(`${runner} --package`, pkg) };
    }
    const [target] = options.rest;
    return target === undefined ? NONE : { kind: 'fetch', call: callText(runner, target) };
}
/** A runner's subcommand, after its leading options, with the words after it. */
function subcommandOf(args, valued) {
    const options = readOptions(args, valued);
    const [head, ...rest] = options.rest;
    return { name: head === undefined || head.dynamic ? undefined : head.text, rest, options };
}
function npmCall(args) {
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
function pnpmCall(args) {
    const { name, rest } = subcommandOf(args, PNPM_VALUED);
    return name === 'dlx' || name === 'create' ? fetchCall(`pnpm ${name}`, rest, DLX_VALUED) : NONE;
}
function yarnCall(args) {
    const { name, rest } = subcommandOf(args, YARN_VALUED);
    return name === 'dlx' || name === 'create' ? fetchCall(`yarn ${name}`, rest, DLX_VALUED) : NONE;
}
function bunCall(args) {
    const { name, rest } = subcommandOf(args, BUN_VALUED);
    if (name === 'x') {
        return execCall('bun x', rest, NO_FLAGS, undefined);
    }
    return name === 'create' ? fetchCall('bun create', rest, NO_FLAGS) : NONE;
}
/** Each package runner by program name. */
const RUNNERS = new Map([
    ['npx', (args) => execCall('npx', args, NPX_NO_FETCH, undefined)],
    ['npm', npmCall],
    ['pnpx', (args) => fetchCall('pnpx', args, DLX_VALUED)],
    ['pnpm', pnpmCall],
    ['yarn', yarnCall],
    ['bunx', (args) => execCall('bunx', args, NO_FLAGS, undefined)],
    ['bun', bunCall],
]);
/** What a program run does as a package runner; see {@link RunnerCall}. */
export function runnerCallOf(run) {
    return RUNNERS.get(run.name)?.(run.args) ?? NONE;
}
