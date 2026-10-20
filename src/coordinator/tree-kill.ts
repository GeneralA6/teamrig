import { execFile } from 'node:child_process';
import { treeOf, wholeNumberTriples, type ProcessLink } from './processes.ts';

/** Ends a process and every process it started; settles once they are ended or the kill gave up, and never rejects. */
export type TreeKill = (pid: number) => Promise<void>;

/** A kill begun on a run: why (its time limit, or its `stop` aborting) and the kill, settled once the tree is ended. */
export interface RunKill {
  readonly why: 'timedOut' | 'stopped';
  readonly done: Promise<void>;
}

/** One process as the Windows sweep lists it: its id, its parent's and when it started, in ms since the epoch. */
export interface StartedProcess extends ProcessLink {
  readonly startedMs: number;
}

/** What the Windows sweep needs from the host. */
export interface SweepHost {
  /** Every process now; undefined when they cannot be listed. */
  list(): Promise<readonly StartedProcess[] | undefined>;
  /** Force-ends these processes with their trees, as `taskkill /F /T` does; settles once the kill is done. */
  kill(pids: readonly number[]): Promise<void>;
  now(): number;
}

/** The most list-and-kill rounds a sweep makes: each round ends what the one before missed while it killed. */
export const SWEEP_ROUNDS = 5;

/** Bounds a process list or a taskkill, so a hung one cannot hold a timed-out step forever. */
const HOST_CALL_TIMEOUT_MS = 30_000;

/** Bytes a process list may print: a host with thousands of processes stays far under it. */
const LIST_MAX_BUFFER = 16 * 2 ** 20;

/**
 * The processes the last kill missed: a member it did not end (same id, same start), and the tree of each process
 * a member started (its parent is a member) before the kill ended. A process whose parent id is now held by a
 * different live process, or that started after the kill ended, is a stranger behind a reused id and is left alone.
 */
export function stragglersOf(rows: readonly StartedProcess[], members: ReadonlyMap<number, number>, killedAtMs: number): StartedProcess[] {
  const liveStart = new Map(rows.map((row) => [row.pid, row.startedMs]));
  const parentIsMember = (row: StartedProcess): boolean => {
    const memberStart = members.get(row.parent);
    const parentStart = liveStart.get(row.parent);
    return memberStart !== undefined && (parentStart === undefined || parentStart === memberStart);
  };
  const seeds = rows.filter((row) => (members.has(row.pid) ? members.get(row.pid) === row.startedMs : parentIsMember(row) && row.startedMs <= killedAtMs));
  const found = new Map<number, StartedProcess>();
  for (const seed of seeds) {
    for (const row of treeOf(seed.pid, rows)) {
      found.set(row.pid, row);
    }
  }
  return [...found.values()];
}

/**
 * Ends the tree of `root` on Windows. `taskkill /T` walks parent links once, so a process started while it walks,
 * under a parent it then ends, runs on as an orphan. The sweep lists the host, kills the tree, then lists again
 * and kills the stragglers, until a list finds none or `rounds` run out. With no process list it falls back to one
 * `taskkill /T` of the root.
 */
export async function sweepTree(root: number, host: SweepHost, rounds: number = SWEEP_ROUNDS): Promise<void> {
  const first = await host.list();
  if (first === undefined) {
    await host.kill([root]);
    return;
  }
  const members = new Map<number, number>();
  let targets = treeOf(root, first);
  for (let round = 0; round < rounds && targets.length > 0; round += 1) {
    for (const target of targets) {
      members.set(target.pid, target.startedMs);
    }
    await host.kill(targets.map((target) => target.pid));
    const killedAtMs = host.now();
    const rows = await host.list();
    if (rows === undefined) {
      return;
    }
    targets = stragglersOf(rows, members, killedAtMs);
  }
}

/** Rows of `<pid>,<parent>,<startedMs>` lines; a line that is not three whole numbers is left out. */
export function parseStartedProcesses(text: string): StartedProcess[] {
  return wholeNumberTriples(text).map(([pid, parent, startedMs]) => ({ pid, parent, startedMs }));
}

/** Win32_Process with each start as Unix ms; a process with no start (the idle and system ones) prints 0. */
const LIST_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { ' +
  "'{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) }";

/** The real Windows host: PowerShell lists the processes, `taskkill /F /T` ends them; a failed call ends nothing. */
export const windowsSweepHost: SweepHost = {
  list: () =>
    new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT],
        { windowsHide: true, maxBuffer: LIST_MAX_BUFFER, timeout: HOST_CALL_TIMEOUT_MS },
        (error, stdout) => resolve(error === null ? parseStartedProcesses(stdout) : undefined),
      );
    }),
  kill: (pids) =>
    new Promise((resolve) => {
      const args = ['/F', '/T', ...pids.flatMap((pid) => ['/PID', String(pid)])];
      // taskkill exits non-zero when one of the processes had already ended; the next list finds any it missed.
      execFile('taskkill', args, { windowsHide: true, timeout: HOST_CALL_TIMEOUT_MS }, () => resolve());
    }),
  now: () => Date.now(),
};

/**
 * On Windows the sweep ends the tree: killing only the shell would leave the command it started running, and one
 * `taskkill /T` can miss a process started while it runs. On POSIX the step runs as its own process group, and the
 * group is killed; an orphan stays in its group.
 */
export function nodeTreeKill(platform: NodeJS.Platform, host: SweepHost = windowsSweepHost): TreeKill {
  if (platform === 'win32') {
    return (pid) => sweepTree(pid, host);
  }
  return (pid) => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group ended on its own between the timer and the kill.
    }
    return Promise.resolve();
  };
}
