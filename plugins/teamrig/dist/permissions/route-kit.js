import { REST_MARKER } from "../cli/args.js";
import { REGISTER_COMMANDS } from "../automode/lines.js";
import { KIT_NAME } from "../core/home.js";
import { placeProgram } from "../exec/client-launch.js";
import { readable } from "../slash/plan.js";
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
};
/** A path from the root of a drive or of the file system, as bash or Windows writes it. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
/** True when `words` run `shape` through this install's own teamrig. */
export async function matchesKit(shape, words, context) {
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
function positionalsFit(shape, positionals) {
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
export function ownClientOf(search, installs, at) {
    return async (word) => {
        const bare = !/[\\/]/.test(word);
        if (bare ? word !== KIT_NAME : !ABSOLUTE.test(word)) {
            return false;
        }
        const placed = await placeProgram(word, at, search);
        return placed.kind === 'appended' || (placed.kind === 'file' && installs.isOwnLauncher(placed.path));
    };
}
