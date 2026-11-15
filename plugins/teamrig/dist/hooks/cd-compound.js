import * as nodePath from 'node:path';
import { recordField, stringField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { resolveDir } from "../push-guard/location.js";
import { bashDrivePath } from "../secret-guard/paths.js";
import { rerunOf } from "./rerun-forms.js";
/** Whether the guard looks at this payload: the switch is on and it is a PreToolUse call of Bash. */
export function guardsCdCompound(enabled, payload) {
    return enabled && stringField(payload, 'hook_event_name') === 'PreToolUse' && stringField(payload, 'tool_name') === 'Bash';
}
/**
 * The rerun form of a Bash `command` whose leading `cd D &&` Claude Code asks about: git runs after the move, or D lies
 * outside `place.cwd`. Undefined for any other line, and for one with no rerun form.
 */
export function cdCompoundForm(command, place) {
    const rerun = rerunOf('Bash', command);
    if (rerun?.folder === undefined) {
        return undefined;
    }
    return rerun.programs.includes('git') || leaves(rerun.folder, place) ? rerun.form : undefined;
}
/** The rerun form for the Bash command of a hook `payload`, as {@link cdCompoundForm} gives it. */
export function cdCompoundFormOf(payload, place) {
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    return command === undefined ? undefined : cdCompoundForm(command, place);
}
/** Why the line is refused, quoting the `form` to run instead. */
export function cdCompoundReason(form) {
    return (`${KIT_NAME} picker guard: Claude Code asks a person before a \`cd\` compound that runs git or leaves the session's folder,` +
        ` and that prompt holds this session until someone answers. Do not retry this line; rerun it as: ${form}`);
}
/** True when `folder`, resolved from the session's folder, is not that folder or one inside it. */
function leaves(folder, place) {
    const host = place.host ?? nodePath;
    const cwd = resolveDir(undefined, bashDrivePath(place.cwd, place.home), place.home, host);
    const target = resolveDir(cwd, bashDrivePath(folder, place.home), place.home, host);
    if (cwd === undefined || target === undefined) {
        return true;
    }
    const rules = [cwd, target].some((path) => /^[A-Za-z]:/.test(path)) ? nodePath.win32 : host;
    const relative = rules.relative(cwd, target);
    return relative === '..' || relative.startsWith(`..${rules.sep}`) || rules.isAbsolute(relative);
}
