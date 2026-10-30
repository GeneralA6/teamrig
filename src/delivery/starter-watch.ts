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

/** Where the launcher (plugins/teamrig/bin/teamrig) records, under Git Bash, the Windows ids of the shell that ran it and its own. */
export const SHELL_PID_ENV = 'TEAMRIG_SHELL_WINPID';
export const LAUNCHER_PID_ENV = 'TEAMRIG_LAUNCHER_WINPID';

/**
 * The shell that ran this process's launcher, as the launcher recorded it. Git Bash runs a command in a forked copy of
 * itself that ends once the launcher starts, so no process listing links the launcher to the shell; only the launcher
 * can name it. Undefined unless the launcher that recorded it is this process's own starter (`parentPid`): a process
 * that inherited an outer launcher's record from a step it runs was not started by that shell.
 */
export function launchingShellOf(env: Readonly<Record<string, string | undefined>>, parentPid: number): number | undefined {
  const shell = Number(env[SHELL_PID_ENV]);
  return Number(env[LAUNCHER_PID_ENV]) === parentPid && Number.isSafeInteger(shell) && shell > 0 ? shell : undefined;
}

/**
 * The processes worth watching: the ones that started this one (`lineage` past its first entry), then the launching
 * shell's (`shellLineage`, from the shell up) where the first stops short of them, up to and with the nearest Claude
 * Code, since what runs above it (a terminal, the desktop) ends a tab only through it; with no Claude Code among them,
 * as in a person's own terminal, every one.
 */
export function startersOf(lineage: readonly ProcessInfo[], shellLineage: readonly ProcessInfo[] = []): readonly ProcessInfo[] {
  const own = lineage.slice(1);
  const starters = [...own, ...shellLineage.filter((shell) => !own.some((starter) => starter.pid === shell.pid))];
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

/** The process a watch is for. */
export interface Watched {
  readonly pid: number;
  /** The shell that ran its launcher, where the launcher named one (`launchingShellOf`). */
  readonly shell: number | undefined;
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
 * The watch over the system's processes: `lineage` once for the process and once for its launching shell, then `alive`
 * on each starter every `everyMs`. A starter whose id another process took between two checks still looks alive; that
 * only leaves the step to its time limit.
 */
export function starterWatch(processes: Pick<SessionProcesses, 'lineage' | 'alive'>, watched: Watched, every: Every, everyMs: number = STARTER_CHECK_MS): StarterWatch {
  return {
    async watch() {
      const [lineage, shellLineage] = await Promise.all([processes.lineage(watched.pid), watched.shell === undefined ? undefined : processes.lineage(watched.shell)]);
      const starters = startersOf(lineage ?? [], shellLineage ?? []);
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
