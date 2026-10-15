/** A command line the CLI cannot act on: it prints the message and its command's usage, and exits 64. */
export class UsageError extends Error {
    name = 'UsageError';
    /** The command or group word the line named, when known, so only that command's usage is printed. */
    command;
    constructor(message, command) {
        super(message);
        this.command = command;
    }
}
/** Asks for the help of the command they follow, wherever a flag or word could stand: `set --help`, `inbox -h`. */
export const HELP_FLAGS = new Set(['--help', '-h']);
/** The command a line names: two words when they form a command (`inbox read`), else one; a group word before `--help`. */
function commandOf(argv, commandFlags) {
    const [first = '', second] = argv;
    const pair = `${first} ${second ?? ''}`;
    if (second !== undefined && commandFlags[pair] !== undefined) {
        return { command: pair, tail: argv.slice(2) };
    }
    if (commandFlags[first] !== undefined) {
        return { command: first, tail: argv.slice(1) };
    }
    if (first === '') {
        throw new UsageError('no command given');
    }
    const actions = Object.keys(commandFlags)
        .filter((name) => name.startsWith(`${first} `))
        .map((name) => name.slice(first.length + 1));
    if (actions.length === 0) {
        throw new UsageError(`unknown command "${first}"`);
    }
    if (second !== undefined && HELP_FLAGS.has(second)) {
        return { command: first, tail: argv.slice(1) };
    }
    throw new UsageError(`${first} ${actions.join('|')}`, first);
}
/**
 * Splits `<command> [words] [--name value] [--switch]...`. Only the command's own flags are
 * accepted, so a typo is refused instead of silently meaning nothing; every flag takes exactly one
 * value, except the command's switches, which take none. A renamed flag is refused with its new name.
 * `--help` or `-h` after the command stops the reading: the line asks for that command's help.
 */
export function parseArgs(argv, commandFlags, commandSwitches = {}, renamedFlags = {}) {
    const { command, tail } = commandOf(argv, commandFlags);
    const allowed = commandFlags[command] ?? [];
    const switchable = commandSwitches[command] ?? [];
    const positionals = [];
    const flags = new Map();
    const switches = new Set();
    for (let index = 0; index < tail.length; index += 1) {
        const token = tail[index] ?? '';
        if (HELP_FLAGS.has(token)) {
            return { command, positionals: [], flags: new Map(), switches: new Set(), help: true };
        }
        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }
        const name = token.slice(2);
        const renamed = renamedFlags[name];
        if (renamed !== undefined) {
            throw new UsageError(`${token} was renamed: use --${renamed}`, command);
        }
        if (switchable.includes(name)) {
            if (switches.has(name)) {
                throw new UsageError(`${token} is given twice`, command);
            }
            switches.add(name);
            continue;
        }
        if (!allowed.includes(name)) {
            throw new UsageError(`${command} takes no ${token}`, command);
        }
        const value = tail[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new UsageError(`${token} needs a value`, command);
        }
        if (flags.has(name)) {
            throw new UsageError(`${token} is given twice`, command);
        }
        flags.set(name, value);
        index += 1;
    }
    return { command, positionals, flags, switches, help: false };
}
export function noPositionals(args) {
    const [extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
}
/** The command's single positional word, such as a task id. */
export function onePositional(args, name) {
    const [value, extra] = args.positionals;
    if (value === undefined) {
        throw new UsageError(`${args.command} needs <${name}>`);
    }
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    return value;
}
export function requiredFlag(flags, name) {
    const value = flags.get(name);
    if (value === undefined) {
        throw new UsageError(`--${name} is required`);
    }
    return value;
}
