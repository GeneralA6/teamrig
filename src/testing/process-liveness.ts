import { windowsSweepHost, type SweepHost } from '../coordinator/tree-kill.ts';

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
    return rows.some((row) => row.pid === written.pid && row.startedMs <= written.writtenMs);
  };
}
