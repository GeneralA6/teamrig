import { isClaudeProcess, type ProcessInfo, type SessionProcesses } from '../open/session-processes.ts';

/**
 * How often a watch looks: one signal 0 per starter, cheap enough to run through a whole step, and soon enough that a
 * step left behind frees the host lock and its memory within seconds.
 */
export const STARTER_CHECK_MS = 5_000;

/** Runs `check` every `everyMs` until the returned stop is called; the real one never keeps the process alive by itself. */
export type Every = (everyMs: number, check: () => void) => () => void;

export const nodeEvery: Every = (everyMs, check) => {
  const timer = setInterval(check, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * The processes worth watching: the ones that started this one (`lineage` past its first entry), up to and with the
 * nearest Claude Code, since what runs above it (a terminal, the desktop) ends a tab only through it; with no Claude
 * Code among them, as in a person's own terminal, every one.
 */
export function startersOf(lineage: readonly ProcessInfo[]): readonly ProcessInfo[] {
  const starters = lineage.slice(1);
  const claude = starters.findIndex(isClaudeProcess);
  return claude === -1 ? starters : starters.slice(0, claude + 1);
}

/** One watch of this process's starters. */
export interface StarterWatching {
  /** The starters it checks; none when the system would not list them, and then nothing is ever found ended. */
  readonly starters: readonly ProcessInfo[];
  /** Aborts once a starter has ended: for the lock's wait and the step it guards. */
  readonly stop: AbortSignal;
  /** The starter found ended; undefined while every one runs. */
  ended(): ProcessInfo | undefined;
  /** Ends the checks. */
  close(): void;
}

/** The starter a watch found ended, as `bash.exe 4100`; while every one runs, `a process that started it`. */
export function endedText(watching: Pick<StarterWatching, 'ended'>): string {
  const ended = watching.ended();
  return ended === undefined ? 'a process that started it' : `${ended.name} ${ended.pid}`;
}

/**
 * Watches the processes that started this one. Claude Code may end a Bash tool's shell alone (its low-memory reaper
 * does), and on Windows what the shell started runs on: a launcher's `sh` stub too, so the direct starter alone can
 * look fine while the shell above it is gone. Any starter that ends means no one waits for this process's work.
 */
export interface StarterWatch {
  /** Lists this process's starters once and checks them until closed. */
  watch(): Promise<StarterWatching>;
}

/**
 * The watch over the system's processes: `lineage` once, then `alive` on each starter every `everyMs`. A starter whose
 * id another process took between two checks still looks alive; that only leaves the step to its time limit.
 */
export function starterWatch(processes: Pick<SessionProcesses, 'lineage' | 'alive'>, pid: number, every: Every, everyMs: number = STARTER_CHECK_MS): StarterWatch {
  return {
    async watch() {
      const starters = startersOf((await processes.lineage(pid)) ?? []);
      const controller = new AbortController();
      let ended: ProcessInfo | undefined;
      let cancel: () => void = () => undefined;
      if (starters.length > 0) {
        cancel = every(everyMs, () => {
          ended = starters.find((starter) => !processes.alive(starter.pid));
          if (ended !== undefined) {
            cancel();
            controller.abort();
          }
        });
      }
      return { starters, stop: controller.signal, ended: () => ended, close: () => cancel() };
    },
  };
}
