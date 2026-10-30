import { windowsSweepHost, type StartedProcess, type SweepHost } from '../delivery/tree-kill.ts';

/** A process a spec started, as it wrote itself down once it ran: `${process.pid} ${Date.now()}`. */
export interface WrittenProcess {
  readonly pid: number;
  /** When it wrote the line, in ms since the epoch: after the host recorded its start. */
  readonly writtenMs: number;
}

/** Whether a process holds `pid`, by signal 0, which only checks: EPERM means one runs as another user. */
export type PidCheck = (pid: number) => boolean;

/** Whether the process that wrote itself down still runs. */
export type Liveness = (written: WrittenProcess) => Promise<boolean>;

/** The line a spec's process writes to say it runs: its id and the time, read back by `parseWrittenProcess`. */
export const WRITE_PROCESS_SCRIPT = "require('node:fs').writeFileSync(process.argv[2], `${process.pid} ${Date.now()}`)";

/** Reads a `<pid> <ms>` line; undefined when it is not two whole numbers. */
export function parseWrittenProcess(text: string): WrittenProcess | undefined {
  const match = /^(\d+) (\d+)$/.exec(text.trim());
  return match === null ? undefined : { pid: Number(match[1]), writtenMs: Number(match[2]) };
}

export const signalPidCheck: PidCheck = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
};

/** Force-ends the process holding `pid`, by signal; one already ended is no error. */
export type PidKill = (pid: number) => void;

/** Ends the process that wrote itself down if it still runs; settles once the kill is done. */
export type Ending = (written: WrittenProcess) => Promise<void>;

export const signalPidKill: PidKill = (pid) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // It ended on its own.
  }
};

/** The listed process that is the one that wrote itself down: it holds the id and started no later than it wrote. */
function writerOf(rows: readonly StartedProcess[], written: WrittenProcess): StartedProcess | undefined {
  return rows.find((row) => row.pid === written.pid && row.startedMs <= written.writtenMs);
}

/**
 * Windows hands an ended process's id to a new process within seconds under load (T990), so there a process runs only
 * while a listed process holds its id and started no later than it wrote itself down; a later start is a stranger.
 * When the host cannot be listed, and on POSIX, which does not reuse ids that soon, signal 0 answers.
 */
export function livenessOf(platform: NodeJS.Platform, host: Pick<SweepHost, 'list'> = windowsSweepHost, pidCheck: PidCheck = signalPidCheck): Liveness {
  if (platform !== 'win32') {
    return (written) => Promise.resolve(pidCheck(written.pid));
  }
  return async (written) => {
    const rows = await host.list();
    if (rows === undefined) {
      return pidCheck(written.pid);
    }
    return writerOf(rows, written) !== undefined;
  };
}

/**
 * Ends a process a spec started by what it is, not by its id alone: on Windows a bare id can name a stranger given it
 * after the process ended (T1562), so there the kill ends only the listed writer, by id and start; when the host cannot
 * be listed it ends nothing, since a bare id may be a stranger's. On POSIX, which does not reuse ids that soon, a
 * signal ends it.
 */
export function endingOf(platform: NodeJS.Platform, host: Pick<SweepHost, 'list' | 'kill'> = windowsSweepHost, pidKill: PidKill = signalPidKill): Ending {
  if (platform !== 'win32') {
    return (written) => {
      pidKill(written.pid);
      return Promise.resolve();
    };
  }
  return async (written) => {
    const rows = await host.list();
    const writer = rows === undefined ? undefined : writerOf(rows, written);
    if (writer !== undefined) {
      await host.kill([writer]);
    }
  };
}
