/** The end Node reports on `close`: a code, or no code and the signal that stopped the process. */
export function endOf(code, signal) {
    return code === null ? { kind: 'signal', signal: signal ?? 'an unknown signal' } : { kind: 'exited', code };
}
