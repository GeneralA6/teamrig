import { REST_MARKER } from '../cli/args.ts';
import { REGISTER_COMMANDS } from '../automode/lines.ts';
import { KIT_NAME } from '../core/home.ts';
import { placeProgram, type ClientInstalls, type ClientSearch, type WordAt } from '../exec/client-launch.ts';
import { readable, type CommandTable } from '../slash/plan.ts';

/**
 * The teamrig commands a sanctioned route may run (T679, security rulings C2 and C3). A line matches only as the CLI
 * itself reads it, with the CLI's own command table, so `rules forget` is never read as `rules` and a word, and an
 * unknown flag, a help request or a `--` is no match. The program word must start this install's own launcher (C2).
 */

/** What a teamrig route needs beyond the line's words. */
export interface KitContext {
  /** The CLI's command table, which reads the line as the CLI will. */
  readonly cli: CommandTable;
  /** True when a program word starts this install's own teamrig; see {@link ownClientOf}. */
  readonly ownClient: (word: string) => Promise<boolean>;
}

/** How a teamrig command is written to be a route. */
export interface KitShape {
  /** The commands it takes, as the CLI names them. */
  readonly commands: readonly string[];
  /** The flags and switches it may carry; undefined for every one the CLI gives the command. */
  readonly options: readonly string[] | undefined;
  /** `none`; `one` word not starting `-`; or `any`. */
  readonly positionals: 'none' | 'one' | 'any';
}

/** The teamrig routes. `deploy` is its pull form only: its `--targets`/`--what -- <cmd>` form runs a command. */
export const KIT_SHAPES = {
  merge: { commands: ['merge'], options: ['session', 'keep-remote', 'no-delete-local'], positionals: 'none' },
  deploy: { commands: ['deploy'], options: ['session', 'repo'], positionals: 'none' },
  /** Never `exec approve`, `exec run` or `exec dry-run` (C8). */
  execRequest: { commands: ['exec request'], options: ['session', 'file'], positionals: 'none' },
  /** Narrower than the CLI: no `--base`. */
  worktreeRemove: { commands: ['worktree remove'], options: ['session', 'delete-branch', 'dry-run'], positionals: 'one' },
  /** The commands every session runs on the team's own files. */
  register: { commands: REGISTER_COMMANDS, options: undefined, positionals: 'any' },
} as const satisfies Readonly<Record<string, KitShape>>;

/** A path from the root of a drive or of the file system, as bash or Windows writes it. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

/** True when `words` run `shape` through this install's own teamrig. */
export async function matchesKit(shape: KitShape, words: readonly string[], context: KitContext): Promise<boolean> {
  const [program, ...argv] = words;
  if (program === undefined || argv.includes(REST_MARKER)) {
    return false;
  }
  const parsed = readable(argv, context.cli);
  if (parsed === undefined || parsed.help || !shape.commands.includes(parsed.command)) {
    return false;
  }
  const options = [...parsed.flags.keys(), ...parsed.switches];
  const allowed = shape.options;
  if (allowed !== undefined && !options.every((name) => allowed.includes(name))) {
    return false;
  }
  return positionalsFit(shape.positionals, parsed.positionals) && context.ownClient(program);
}

function positionalsFit(shape: KitShape['positionals'], positionals: readonly string[]): boolean {
  if (shape === 'any') {
    return true;
  }
  const [first, ...more] = positionals;
  return shape === 'none' ? first === undefined : first !== undefined && !first.startsWith('-') && more.length === 0;
}

/**
 * C2: a program word starts this install's own bash launcher when it is a bare `teamrig` that no folder the hook sees
 * holds before the plugin bin Claude Code appends, or names that launcher by its absolute path. A relative path, or
 * any other install or entry, starts no route.
 */
export function ownClientOf(search: ClientSearch, installs: ClientInstalls, at: WordAt): (word: string) => Promise<boolean> {
  return async (word) => {
    const bare = !/[\\/]/.test(word);
    if (bare ? word !== KIT_NAME : !ABSOLUTE.test(word)) {
      return false;
    }
    const placed = await placeProgram(word, at, search);
    return placed.kind === 'appended' || (placed.kind === 'file' && installs.isOwnLauncher(placed.path));
  };
}
