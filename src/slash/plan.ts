import {
  parseArgs,
  REST_MARKER,
  UsageError,
  type CommandEffects,
  type CommandFlags,
  type CommandRest,
  type CommandSwitches,
  type ParsedArgs,
  type Renamed,
} from '../cli/args.ts';

/** The CLI's command table, as `/teamrig` reads it (src/cli/run.ts): the same as the CLI parses a line with, plus each command's effect. */
export interface CommandTable {
  readonly flags: CommandFlags;
  readonly switches: CommandSwitches;
  readonly renamed: Renamed;
  readonly rest: CommandRest;
  readonly effects: CommandEffects;
}

/**
 * What one `/teamrig` line does, as far as `/teamrig` cares: `read` changes nothing, `write` does. A line the
 * CLI cannot read, or a help request, runs nothing, so it is a `read`; a command with no effect in the
 * table is a `write`, because a write is never the default.
 */
export type LineEffect = 'read' | 'write';

/**
 * What `/teamrig <words>` does:
 * - `help`: nothing was typed; print the short help.
 * - `as-typed`: run the words unchanged: `--session` was given, the command takes none, or the line is
 *   one the CLI itself answers (help, version, a usage error).
 * - `fill`: a command that takes `--session` and was given none: run it as this tab's session, the line
 *   then being `withSession`'s.
 * - `internal`: a command Claude Code or teamrig runs itself, with its input on stdin: refused.
 */
export type SlashPlan =
  | { readonly kind: 'help' }
  | { readonly kind: 'as-typed'; readonly argv: readonly string[]; readonly effect: LineEffect }
  | { readonly kind: 'fill'; readonly command: string; readonly argv: readonly string[]; readonly effect: LineEffect }
  | { readonly kind: 'internal'; readonly command: string };

/** The flag that names the caller, or the owner a read filters on. */
export const SESSION_FLAG = 'session';

/** The line as the CLI will read it, with the CLI's own table; undefined when the CLI refuses it. */
export function readable(argv: readonly string[], table: CommandTable): ParsedArgs | undefined {
  try {
    return parseArgs(argv, table.flags, table.switches, table.renamed, table.rest);
  } catch (error) {
    if (error instanceof UsageError) {
      return undefined;
    }
    throw error;
  }
}

/** Plans one `/teamrig` line from its words and the CLI's command table; reads and writes nothing. */
export function planSlash(argv: readonly string[], table: CommandTable): SlashPlan {
  if (argv.length === 0) {
    return { kind: 'help' };
  }
  const parsed = readable(argv, table);
  // A line the CLI cannot read, or a help request: the CLI prints the reason or the help itself.
  if (parsed === undefined || parsed.help) {
    return { kind: 'as-typed', argv, effect: 'read' };
  }
  const { command } = parsed;
  const declared = table.effects[command];
  if (declared === 'internal') {
    return { kind: 'internal', command };
  }
  const effect: LineEffect = declared === 'read' ? 'read' : 'write';
  if (!(table.flags[command] ?? []).includes(SESSION_FLAG) || parsed.flags.has(SESSION_FLAG)) {
    return { kind: 'as-typed', argv, effect };
  }
  return { kind: 'fill', command, argv, effect };
}

/**
 * A `fill` line with `--session <session>` added after the command's own flags: last, or just before the
 * `--` that starts the command line a command such as `test` runs, so it never becomes part of that line.
 */
export function withSession(plan: { readonly command: string; readonly argv: readonly string[] }, session: string, table: CommandTable): readonly string[] {
  const flag = [`--${SESSION_FLAG}`, session];
  const marker = table.rest.has(plan.command) ? plan.argv.indexOf(REST_MARKER, plan.command.split(' ').length) : -1;
  return marker === -1 ? [...plan.argv, ...flag] : [...plan.argv.slice(0, marker), ...flag, ...plan.argv.slice(marker)];
}

/** The read commands `/teamrig` runs as the tab's session at once when no `--session` is given, in table order. */
export function sessionReads(table: CommandTable): string[] {
  return Object.keys(table.effects).filter((command) => table.effects[command] === 'read' && (table.flags[command] ?? []).includes(SESSION_FLAG));
}
