import { isRecord } from "../core/guards.js";
function argsOf(handler) {
    const args = handler['args'];
    return Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [];
}
/** The `command` hooks of `events` in that order, each event's in file order; every event's when `events` is undefined. */
export function hookCommandsOf(settings, events) {
    const hooks = settings['hooks'];
    if (!isRecord(hooks)) {
        return [];
    }
    return (events ?? Object.keys(hooks)).flatMap((event) => {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
        const handlers = groups.flatMap((group) => (isRecord(group) && Array.isArray(group['hooks']) ? group['hooks'] : []));
        return handlers.flatMap((handler) => (isRecord(handler) && typeof handler['command'] === 'string' ? [{ event, command: handler['command'], args: argsOf(handler) }] : []));
    });
}
/** What a hook runs as one line: its command, then each argument, quoted when it holds a space. */
export function hookCommandLine(hook) {
    return [hook.command, ...hook.args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' ');
}
