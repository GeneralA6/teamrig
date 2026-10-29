/** The signals that end a run from outside: its tab or console window closed (SIGHUP, on Windows too), Ctrl+C, Ctrl+Break, the system. */
export const STOP_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGBREAK', 'SIGTERM'];
/** Each stop signal's number, for the exit code a process a signal ends reports (128 + it). */
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGBREAK: 21, SIGTERM: 15 };
/**
 * The process's stop watch. A listener takes away Node's own exit on the signal, so once `onStop` has run, or
 * failed, the process exits as that signal would have ended it; a second signal meanwhile is ignored.
 */
export function processStopWatch(target) {
    return {
        watch(onStop) {
            let stopping = false;
            const listeners = STOP_SIGNALS.map((signal) => [
                signal,
                () => {
                    if (stopping) {
                        return;
                    }
                    stopping = true;
                    const exit = () => target.exit(128 + SIGNAL_NUMBERS[signal]);
                    void onStop(signal).then(exit, exit);
                },
            ]);
            for (const [signal, listener] of listeners) {
                target.on(signal, listener);
            }
            return () => {
                for (const [signal, listener] of listeners) {
                    target.off(signal, listener);
                }
            };
        },
    };
}
