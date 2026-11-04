import { parseArgs, REST_MARKER, UsageError, } from "../cli/args.js";
/** The flag that names the caller, or the owner a read filters on. */
export const SESSION_FLAG = 'session';
/** The line as the CLI will read it, with the CLI's own table; undefined when the CLI refuses it. */
export function readable(argv, table) {
    try {
        return parseArgs(argv, table.flags, table.switches, table.renamed, table.rest);
    }
    catch (error) {
        if (error instanceof UsageError) {
            return undefined;
        }
        throw error;
    }
}
/** Plans one `/teamrig` line from its words and the CLI's command table; reads and writes nothing. */
export function planSlash(argv, table) {
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
    const effect = declared === 'read' ? 'read' : 'write';
    if (!(table.flags[command] ?? []).includes(SESSION_FLAG) || parsed.flags.has(SESSION_FLAG)) {
        return { kind: 'as-typed', argv, effect };
    }
    return { kind: 'fill', command, argv, effect };
}
/**
 * A `fill` line with `--session <session>` added after the command's own flags: last, or just before the
 * `--` that starts the command line a command such as `test` runs, so it never becomes part of that line.
 */
export function withSession(plan, session, table) {
    const flag = [`--${SESSION_FLAG}`, session];
    const marker = table.rest.has(plan.command) ? plan.argv.indexOf(REST_MARKER, plan.command.split(' ').length) : -1;
    return marker === -1 ? [...plan.argv, ...flag] : [...plan.argv.slice(0, marker), ...flag, ...plan.argv.slice(marker)];
}
/** The read commands `/teamrig` runs as the tab's session at once when no `--session` is given, in table order. */
export function sessionReads(table) {
    return Object.keys(table.effects).filter((command) => table.effects[command] === 'read' && (table.flags[command] ?? []).includes(SESSION_FLAG));
}
