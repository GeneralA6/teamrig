import { isRecord, recordField, stringField } from "../core/guards.js";
import { PASS_RECORD_FOLDER } from "../push-guard/pass-record.js";
import { refusalOutput } from "./permission.js";
/**
 * The pass-record guard: a tree's pass record (src/push-guard/pass-record.ts) lets a push or a merge skip the checks
 * that tree already passed, so only the repo's local runner may write one. The guard refuses a session's own write of
 * one: a file tool naming a path in the records' folder, and a shell line naming the folder at all (the line's reads
 * too, since a shell line's writes cannot be told from its reads; the Read and Grep tools stay open). It reads only the
 * call: a script the line starts, or a path built when it runs, still reaches the folder, since sessions and the
 * runner share one account (stopgap T791: phase 2 runs the runner on an account of its own).
 */
/** The tools that write a file, by the input field that names it. */
const FILE_WRITERS = new Map([
    ['Write', 'file_path'],
    ['Edit', 'file_path'],
    ['MultiEdit', 'file_path'],
    ['NotebookEdit', 'notebook_path'],
]);
const SHELLS = new Set(['Bash', 'PowerShell']);
/** A path with the records' folder as one of its folders, either slash, any case. */
const IN_RECORD_FOLDER = new RegExp(`(^|[\\\\/])${PASS_RECORD_FOLDER}[\\\\/]`, 'i');
/** The folder's name as a word of its own: `.git/local-ci/x.json`, `'local-ci'`, not `my-local-ci`. */
const NAMES_RECORD_FOLDER = new RegExp(`(?<![\\w-])${PASS_RECORD_FOLDER}(?![\\w-])`, 'i');
/** What in the call reaches the pass records, for the reason; undefined when nothing does. */
export function passRecordReach(payload) {
    const tool = stringField(payload, 'tool_name');
    if (tool === undefined) {
        return undefined;
    }
    const input = recordField(payload, 'tool_input') ?? {};
    const field = FILE_WRITERS.get(tool);
    if (field !== undefined) {
        const path = stringField(input, field);
        return path !== undefined && IN_RECORD_FOLDER.test(path) ? `this ${tool} writes ${path}, in the folder of the trees' pass records` : undefined;
    }
    if (SHELLS.has(tool)) {
        const command = stringField(input, 'command');
        return command !== undefined && NAMES_RECORD_FOLDER.test(command) ? `this ${tool} line names ${PASS_RECORD_FOLDER}, the folder of the trees' pass records` : undefined;
    }
    return undefined;
}
/** Why the call is refused, with what to do instead. */
export function passRecordReason(reach) {
    return (`teamrig pass-record guard: ${reach}. Only the repo's local runner writes a record, after every check passed on ` +
        'the tree (its pre-push hook, `ship.ts check`); one a session writes, moves or deletes would let a push or a merge ' +
        "skip the tree's tests. Run the repo's local checks instead; read a record with the Read tool and search code with " +
        'the Grep tool. Do not retry this or route around it: a record that looks wrong goes to the lead.');
}
/** The PreToolUse output for a file write or a shell call: a refusal when it reaches the pass records, else nothing. */
export function passRecordGuardOutput(payload) {
    if (!isRecord(payload)) {
        return '';
    }
    const reach = passRecordReach(payload);
    return reach === undefined ? '' : refusalOutput(passRecordReason(reach));
}
