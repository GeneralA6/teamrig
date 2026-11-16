import { ABSOLUTE } from "./route-kit.js";
/** The queue's options a ship call may carry; `--kind` must be there. */
const QUEUE_OPTIONS = new Set(['kind', 'session', 'what', 'task', 'max-minutes', 'detach']);
/** The queue kinds a ship call that merges runs under: the ones that take the ship slot. */
const MERGE_KINDS = new Set(['ship', 'merge']);
/** The queue kind a ship call without --merge runs under. */
const REVIEW_KIND = 'test';
/** The one node flag a ship call may pass: it hides the type-stripping warning, and changes nothing the tool does. */
const NODE_FLAG = '--disable-warning=ExperimentalWarning';
/** A commit sha, short or full, as the tool's `--approved` takes it. */
const APPROVED_SHA = /^[0-9a-f]{7,40}$/;
/** The tool's words after its positionals: `--merge` alone, and two flags that take a value. */
const MERGE_SWITCH = '--merge';
const APPROVED = '--approved';
const NOTE_FILE = '--note-file';
/** A path the tool takes: absolute, so the allow checks the place the tool opens whatever its folder. */
function isPathWord(word) {
    return word !== undefined && ABSOLUTE.test(word);
}
/** The tool's flags in `words`, each once and in its own slot; undefined for any other word. */
function toolFlagsOf(words, takesMerge) {
    let merge = false;
    let approved = false;
    let note;
    for (let at = 0; at < words.length; at++) {
        const word = words[at];
        const value = words[at + 1];
        if (word === MERGE_SWITCH && takesMerge && !merge) {
            merge = true;
        }
        else if (word === APPROVED && !approved && value !== undefined && APPROVED_SHA.test(value)) {
            approved = true;
            at++;
        }
        else if (word === NOTE_FILE && note === undefined && isPathWord(value)) {
            note = value;
            at++;
        }
        else {
            return undefined;
        }
    }
    return { merge, approved, note };
}
/** The ship run the words after the queue's `--` make, when they run the configured tool in a ship shape. */
export function shipRunOf(rest, isShipTool, task) {
    const [program, ...after] = rest;
    const [tool, ...args] = after[0] === NODE_FLAG ? after.slice(1) : after;
    if (program !== 'node' || !isPathWord(tool) || !isShipTool(tool)) {
        return undefined;
    }
    const mergeForm = args[0] === 'merge';
    const [worktree, plan] = mergeForm ? [args[1], undefined] : [args[0], args[1]];
    const flags = toolFlagsOf(args.slice(2), !mergeForm);
    if (!isPathWord(worktree) || (!mergeForm && !isPathWord(plan)) || flags === undefined) {
        return undefined;
    }
    // The tool reads --approved and --note-file only for a merge (ship-plan.ts), so a ship without --merge names neither.
    if (!mergeForm && !flags.merge && (flags.approved || flags.note !== undefined)) {
        return undefined;
    }
    const files = [plan, flags.note].filter((file) => file !== undefined);
    return { tool, worktree, files, task, merges: mergeForm || flags.merge };
}
/** The ship run a parsed `teamrig queue` line makes through this install's own launcher; undefined for any other line. */
export async function shipCallOf(program, parsed, context) {
    const options = [...parsed.flags.keys(), ...parsed.switches];
    const kind = parsed.flags.get('kind');
    if (parsed.command !== 'queue' || parsed.help || parsed.positionals.length > 0 || kind === undefined || (!MERGE_KINDS.has(kind) && kind !== REVIEW_KIND)) {
        return undefined;
    }
    if (!options.every((name) => QUEUE_OPTIONS.has(name))) {
        return undefined;
    }
    const run = shipRunOf(parsed.rest, context.isShipTool, parsed.flags.get('task'));
    if (run === undefined || run.merges !== MERGE_KINDS.has(kind)) {
        return undefined;
    }
    return (await context.ownClient(program)) ? run : undefined;
}
