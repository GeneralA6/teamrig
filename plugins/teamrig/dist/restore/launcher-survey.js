import { isRecord, stringField } from "../core/guards.js";
/** A machine where nothing starts the restore. */
export const EMPTY_SURVEY = { registered: [], found: [] };
function kindOf(value) {
    return value === 'logon' || value === 'shortcut' ? value : undefined;
}
function registeredOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const kind = kindOf(value['kind']);
    const [where, program, script] = ['where', 'program', 'script'].map((key) => stringField(value, key));
    return kind === undefined || where === undefined || program === undefined || script === undefined ? undefined : { kind, where, program, script };
}
function foundOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const kind = kindOf(value['kind']);
    const [where, runs] = ['where', 'runs'].map((key) => stringField(value, key));
    return kind === undefined || where === undefined || runs === undefined ? undefined : { kind, where, runs };
}
/** Each item of `value` as `parse` reads it; undefined when it is no list or any item is damaged. */
function listOf(value, parse) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value.map(parse).filter((item) => item !== undefined);
    return items.length === value.length ? items : undefined;
}
/** The survey a record holds; undefined when it holds none, or a damaged one. */
export function surveyOf(record) {
    const registered = listOf(record['registered'], registeredOf);
    const found = listOf(record['found'], foundOf);
    return registered === undefined || found === undefined ? undefined : { registered, found };
}
/** The survey as the record's fields hold it. */
export function surveyFields(survey) {
    return {
        registered: survey.registered.map(({ kind, where, program, script }) => ({ kind, where, program, script })),
        found: survey.found.map(({ kind, where, runs }) => ({ kind, where, runs })),
    };
}
/** Whether two surveys list the same parts in the same order. */
export function sameSurvey(a, b) {
    return JSON.stringify(surveyFields(a)) === JSON.stringify(surveyFields(b));
}
