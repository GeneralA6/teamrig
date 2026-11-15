/**
 * What the guard entry's thread (guard-thread.ts) and the guard thread (guard-worker.ts) say to each other (T2433).
 * Both sides import this module, so it imports nothing: a module that fails to load under the entry would end it with
 * exit 1, which lets the tool call through. That is why it narrows records itself instead of using core/guards.ts.
 */
function isFields(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isGuardThreadMessage(value) {
    if (!isFields(value)) {
        return false;
    }
    switch (value['kind']) {
        case 'loaded':
            return true;
        case 'load-failed':
        case 'crashed':
            return typeof value['message'] === 'string';
        case 'stdout':
        case 'stderr':
            return typeof value['line'] === 'string';
        case 'answered':
            return typeof value['code'] === 'number';
        default:
            return false;
    }
}
export function isGuardThreadRun(value) {
    if (!isFields(value)) {
        return false;
    }
    const argv = value['argv'];
    return Array.isArray(argv) && argv.every((arg) => typeof arg === 'string') && typeof value['script'] === 'string' && typeof value['input'] === 'string';
}
/** What a thrown value says, to carry across the thread as text. */
export function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
