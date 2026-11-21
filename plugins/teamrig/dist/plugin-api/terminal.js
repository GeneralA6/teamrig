/**
 * A terminal as teamrig drives it: the port a terminal's adapter serves, request for request the terminal protocol
 * of `docs/design/public-interface.md`. A built-in terminal serves it inside teamrig; an outside program is reached
 * through the protocol by a client that serves this same port, so one contract holds both.
 */
/** The protocol's requests, by the names they have on the wire. */
export const TERMINAL_REQUESTS = ['open', 'focus', 'close', 'restart', 'rename', 'deliver', 'isIdle', 'list'];
export function isTerminalRequest(value) {
    return TERMINAL_REQUESTS.some((request) => request === value);
}
/**
 * What a pane is doing: `idle` only when no turn runs, no question shows and its input holds nothing unsent. A
 * person typing into the input is using the pane, so `draft` is not idle.
 */
export const PANE_STATES = ['idle', 'busy', 'asking', 'draft', 'gone'];
export function isPaneState(value) {
    return PANE_STATES.some((state) => state === value);
}
