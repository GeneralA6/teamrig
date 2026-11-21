import { KIT_NAME } from "../core/home.js";
/**
 * The result to redact: the answer of the event's call where its host takes a replacement for it (T1369), since the
 * replacement must keep the answer's shape; undefined for any other call's, which stays as it is.
 */
export function redactableResultOf(event) {
    const { call } = event;
    return call?.replaceable === undefined ? undefined : { tool: call.name, response: call.replaceable };
}
/** Who rotates a leaked secret: the team's security reviewer, else its lead; "the lead" when the config did not load. */
export function rotatorOf(load) {
    return load?.status === 'loaded' ? (load.config.roles.securityReviewer ?? load.config.roles.lead) : 'the lead';
}
const distinct = (values) => [...new Set(values)].join(', ');
/**
 * What the model does about the leak: nothing more where every kind has its rotation task, which it is told; else it
 * asks the rotator for one, told why filing it failed.
 */
export function rotationText(rotator, rotations) {
    const tasks = rotations.flatMap((rotation) => ('task' in rotation ? [rotation.task] : []));
    const problems = rotations.flatMap((rotation) => ('problem' in rotation ? [rotation.problem] : []));
    if (problems.length === 0) {
        return `${rotator} rotates it in ${distinct(tasks)}.`;
    }
    const ask = `ask ${rotator} to rotate ${tasks.length === 0 ? 'it' : 'the rest'} with a register task (filing one failed: ${distinct(problems)}).`;
    return tasks.length === 0 ? ask : `${rotator} rotates it in ${distinct(tasks)}; ${ask}`;
}
/** The line for the model: the kinds found, never a value, what becomes of them, and whether part of the result went unscanned. */
export function redactedLine(redaction, rotation) {
    const line = `${KIT_NAME}: this result held a secret (${redaction.classes.join(', ')}); it was redacted before you saw it. Treat it as leaked: ${rotation} Do not print it again.`;
    return redaction.cut ? `${line} Part of the result was past the scan's cap and was not checked.` : line;
}
