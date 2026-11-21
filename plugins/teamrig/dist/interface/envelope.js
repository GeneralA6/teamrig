import { INTERFACE_VERSION } from "./version.js";
/** The documents version 1 serves, in the order the help names them: the five of 1.0, then each a minor added. */
export const DOCUMENTS = ['tasks', 'inbox', 'sessions', 'meetings', 'config', 'plan', 'goals', 'history'];
export function isDocumentName(text) {
    return DOCUMENTS.some((name) => name === text);
}
/**
 * A document's answer. The head's four fields are written last, so a body that names one of them by mistake cannot
 * replace what a reader takes its bearings from.
 */
export function answerOf(document, revision, problems, body) {
    return { ...body, interface: INTERFACE_VERSION, document, revision, problems };
}
export function unchangedAnswer(document, revision) {
    return { interface: INTERFACE_VERSION, document, revision, unchanged: true };
}
