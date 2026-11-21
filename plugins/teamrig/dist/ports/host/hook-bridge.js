/**
 * The moments of a session a host may call teamrig at, under teamrig's own names. A host maps each of its hook
 * events to one of them, and one it has no name for reaches the core as `other`.
 */
export const HOOK_EVENTS = [
    'session-start',
    'session-end',
    'prompt',
    'tool-start',
    'permission-prompt',
    'tool-end',
    'tool-failed',
    'stop',
    'stop-failed',
    'helper-start',
    'helper-stop',
    'compact-start',
    'compact-end',
    'form-start',
    'form-end',
];
export function isHookEventName(value) {
    return HOOK_EVENTS.some((name) => name === value);
}
