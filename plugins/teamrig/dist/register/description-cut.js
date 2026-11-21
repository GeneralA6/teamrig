import { isNonNegativeInteger, isRecord } from "../core/guards.js";
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH = /^[0-9a-f]{8}$/;
/**
 * FNV-1a (32 bits) of a text's UTF-16 code units, each as its low byte then its high byte, as 8 hex digits. Change
 * detection only: with the length beside it, two texts sharing a mark by chance is about 1 in 4 billion edits, and a
 * text made to share one harms nothing, since the mark only decides whether a sync writes the text again.
 */
export function textHash(text) {
    let hash = FNV_OFFSET;
    for (let index = 0; index < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME);
        hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
/** The mark a task line keeps of `text`. */
export function cutOf(text) {
    return { chars: text.length, hash: textHash(text) };
}
/**
 * The task as a task line holds it: its description left out, its mark in its place. A task with no description is
 * returned as is, one already cut too, so cutting twice gives the same task.
 */
export function cutTask(task) {
    return task.description === null ? task : { ...task, description: null, descriptionCut: cutOf(task.description) };
}
/**
 * True when the task's description is `text`: equal to it on a task holding its description whole (null is none), and
 * matching the mark on a cut one, so a reader that only asks whether a text changed never needs the history.
 */
export function holdsDescription(task, text) {
    const { descriptionCut } = task;
    if (descriptionCut === null) {
        return task.description === text;
    }
    if (text === null) {
        return false;
    }
    const mark = cutOf(text);
    return mark.chars === descriptionCut.chars && mark.hash === descriptionCut.hash;
}
/**
 * The task with the description its task line left out: a cut task takes the text of `whole`, the same task as the
 * history folds it, and holds no mark. A task that is not cut is returned as is, and a cut one stays cut when the
 * history lacks it or holds another text than the one cut, so a reader never shows a text the mark does not name.
 */
export function describedTask(task, whole) {
    if (task.descriptionCut === null || whole === undefined || !holdsDescription(task, whole.description)) {
        return task;
    }
    return { ...task, description: whole.description, descriptionCut: null };
}
/** The mark a task line's `descriptionCut` holds, null for none, or why the value is neither. */
export function parseDescriptionCut(value) {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        return 'descriptionCut is neither a mark nor null';
    }
    const { chars, hash } = value;
    if (!isNonNegativeInteger(chars) || typeof hash !== 'string' || !HASH.test(hash)) {
        return `bad descriptionCut ${JSON.stringify(value)}`;
    }
    return { chars, hash };
}
