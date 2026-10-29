/** The signals that end a run from outside: its tab or console window closed (SIGHUP, on Windows too), Ctrl+C, Ctrl+Break, the system. */
export const STOP_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGBREAK', 'SIGTERM'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** Each stop signal's number, for the exit code a process a signal ends reports (128 + it). */
const SIGNAL_NUMBERS: Readonly<Record<StopSignal, number>> = { SIGHUP: 1, SIGINT: 2, SIGBREAK: 21, SIGTERM: 15 };

/** A stop from outside the run, which it notes before it ends. */
export interface StopWatch {
  /** Runs `onStop` with the signal when the process is told to stop, before it ends; the returned function stops watching. */
  watch(onStop: (signal: StopSignal) => Promise<void>): () => void;
}

/** The part of a Node process a stop watch listens on and ends. */
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): unknown;
  off(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): unknown;
  exit(code: number): void;
}

/**
 * The process's stop watch. A listener takes away Node's own exit on the signal, so once `onStop` has run, or
 * failed, the process exits as that signal would have ended it; a second signal meanwhile is ignored.
 */
export function processStopWatch(target: SignalTarget): StopWatch {
  return {
    watch(onStop) {
      let stopping = false;
      const listeners = STOP_SIGNALS.map((signal): readonly [StopSignal, () => void] => [
        signal,
        () => {
          if (stopping) {
            return;
          }
          stopping = true;
          const exit = (): void => target.exit(128 + SIGNAL_NUMBERS[signal]);
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
