import { describeLaunch } from "../config/launch.js";
import { isEffortLevel } from "../config/types.js";
/** Where Claude Code gives a hook the effort level; it gives the model in the hook's input. */
export const EFFORT_ENV = 'CLAUDE_EFFORT';
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
/** Lowercase, without a `[1m]` window suffix: the window does not change which model runs. */
function bare(model) {
    return model.toLowerCase().replace(/\[[^\]]*\]$/, '');
}
function familyOf(model) {
    return FAMILIES.find((family) => new RegExp(`(?:^|[^a-z])${family}(?:[^a-z]|$)`).test(model));
}
function isFamily(value) {
    return FAMILIES.some((family) => family === value);
}
/**
 * Whether the running model is clearly not the one the config asks for. A family alias matches any
 * model of that family; `opusplan` runs on Opus and Sonnet; a full id matches itself with or without
 * a date or provider wrapping. A running model of no known family is never called wrong.
 */
function isOtherModel(wanted, running) {
    const want = bare(wanted);
    const run = bare(running);
    const family = familyOf(run);
    if (want === 'default' || family === undefined) {
        return false;
    }
    if (want === 'best') {
        return family !== 'fable';
    }
    if (want === 'opusplan') {
        return family !== 'opus' && family !== 'sonnet';
    }
    if (isFamily(want)) {
        return family !== want;
    }
    return !run.includes(want) && !want.includes(run);
}
function present(part) {
    return part !== undefined;
}
/**
 * The one line that tells a session it runs on another model or effort than its configured one,
 * with the commands that fix it; undefined when it matches or Claude Code did not say. It never
 * blocks: the user may have chosen another model on purpose, or the account may lack it.
 */
export function modelCheckLine(name, wanted, running) {
    const model = wanted.model !== undefined && running.model !== undefined && isOtherModel(wanted.model, running.model) ? wanted.model : undefined;
    const runningEffort = isEffortLevel(running.effort) ? running.effort : undefined;
    const effort = runningEffort !== undefined && wanted.effort !== undefined && runningEffort !== wanted.effort ? wanted.effort : undefined;
    if (model === undefined && effort === undefined) {
        return undefined;
    }
    const runs = [running.model === undefined ? undefined : `model ${running.model}`, runningEffort === undefined ? undefined : `at ${runningEffort} effort`];
    const fixes = [model === undefined ? undefined : `/model ${model}`, effort === undefined ? undefined : `/effort ${effort}`];
    const fable = model === 'best' ? ' (if this account has no Fable, best is Opus and nothing needs changing)' : '';
    return `MODEL ${name} runs ${runs.filter(present).join(' ')}; the team config asks for ${describeLaunch(wanted)}: type ${fixes.filter(present).join(' and ')}${fable}`;
}
