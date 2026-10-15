/** A command line the CLI cannot act on: it prints the message and its command's usage, and exits 64. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  /** The command or group word the line named, when known, so only that command's usage is printed. */
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.command = command;
  }
}

/** Asks for the help of the command they follow, wherever a flag or word could stand: `set --help`, `inbox -h`. */
export const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);

export type Flags = ReadonlyMap<string, string>;

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Flags;
  /** The flags given that take no value, such as `--ready`. */
  readonly switches: ReadonlySet<string>;
  /** `--help` or `-h` followed the command: print its help and nothing else; `command` may then be a group word. */
  readonly help: boolean;
}

/** Each command's accepted flags, keyed by the command's words: `add`, `inbox read`. */
export type CommandFlags = Readonly<Partial<Record<string, readonly string[]>>>;

/** Each command's flags that take no value, keyed like `CommandFlags`; most commands have none. */
export type CommandSwitches = CommandFlags;

/**
 * Flags that were renamed, old name to new name. The old name is refused on every command with the
 * new one to use; it is never read as an alias, so one spelling stays in scripts and docs.
 */
export type RenamedFlags = Readonly<Partial<Record<string, string>>>;

/** The command a line names: two words when they form a command (`inbox read`), else one; a group word before `--help`. */
function commandOf(argv: readonly string[], commandFlags: CommandFlags): { readonly command: string; readonly tail: readonly string[] } {
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
export function parseArgs(
  argv: readonly string[],
  commandFlags: CommandFlags,
  commandSwitches: CommandSwitches = {},
  renamedFlags: RenamedFlags = {},
): ParsedArgs {
  const { command, tail } = commandOf(argv, commandFlags);
  const allowed = commandFlags[command] ?? [];
  const switchable = commandSwitches[command] ?? [];
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();
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

export function noPositionals(args: ParsedArgs): void {
  const [extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
}

/** The command's single positional word, such as a task id. */
export function onePositional(args: ParsedArgs, name: string): string {
  const [value, extra] = args.positionals;
  if (value === undefined) {
    throw new UsageError(`${args.command} needs <${name}>`);
  }
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  return value;
}

export function requiredFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}
