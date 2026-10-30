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
  /**
   * Force-ends exactly these processes, none they started, each only while its id still names the process the list saw
   * (the same start); settles once the kill is done.
   */
  kill(targets: readonly StartedProcess[]): Promise<void>;
  /** Force-ends a process with its tree, as `taskkill /F /T` does: the fallback when the host cannot be listed. */
  killTree(root: number): Promise<void>;
  now(): number;
}

/** The most list-and-kill rounds a sweep makes: each round ends one more generation, started before its parent ended. */
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
 * Ends the tree of `root` on Windows. The sweep lists the host, ends exactly the tree's listed processes, then lists
 * again and ends the stragglers, until a list finds none or `rounds` run out. It never kills a listed tree with
 * `taskkill /T`: that walks parent links once and also ends processes the sweep never listed, so a process one of
 * those started during the walk would run on under a parent the sweep never knew. Ending only listed processes, every
 * ended process is a member, so an orphan always has a member parent and the next list finds it. With no first list
 * it falls back to one `taskkill /T` of the root. When a later list fails it stops: killing the last ids again
 * without a fresh list could end a stranger that took one of them.
 */
export async function sweepTree(root: number, host: SweepHost, rounds: number = SWEEP_ROUNDS): Promise<void> {
  const first = await host.list();
  if (first === undefined) {
    await host.killTree(root);
    return;
  }
  const members = new Map<number, number>();
  let targets = treeOf(root, first);
  for (let round = 0; round < rounds && targets.length > 0; round += 1) {
    for (const target of targets) {
      members.set(target.pid, target.startedMs);
    }
    await host.kill(targets);
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

/** Runs a program on the host; settles with what it printed, or undefined when it failed, timed out or never started. */
export type HostRun = (file: string, args: readonly string[]) => Promise<string | undefined>;

const runOnHost: HostRun = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: LIST_MAX_BUFFER, timeout: HOST_CALL_TIMEOUT_MS }, (error, stdout) => resolve(error === null ? stdout : undefined));
  });

/** `/PID <id>` for each process, as taskkill takes them. */
const pidArgs = (pids: readonly number[]): string[] => pids.flatMap((pid) => ['/PID', String(pid)]);

/**
 * Ends each target only while its id still names the process the list saw. Windows hands a freed id to the next new
 * process within milliseconds and a list takes about a second, so a listed process that ended by itself meanwhile (a
 * console host whose shell was just killed) can be another program by the kill, which `taskkill /PID` would end
 * (T1562). The script first opens a handle to each target, which holds its id, then reads their starts through the
 * list's own Win32_Process query and ends, through that handle, only a held process whose start is the listed one; a
 * process with no start is never ended. A target that ended or cannot be opened is skipped; the next list finds any
 * member it missed.
 */
export function killScript(targets: readonly StartedProcess[]): string {
  const wanted = targets.map((target) => `${target.pid} = ${target.startedMs}`).join('; ');
  return (
    `$want = @{ ${wanted} }; $held = @{}; ` +
    'foreach ($id in @($want.Keys)) { try { $p = Get-Process -Id $id -ErrorAction Stop; $null = $p.Handle; $held[$id] = $p } catch {} }; ' +
    'if ($held.Count -gt 0) { ' +
    "Get-CimInstance Win32_Process -Filter ((@($held.Keys) | ForEach-Object { \"ProcessId=$_\" }) -join ' OR ') | ForEach-Object { " +
    '$id = [int]$_.ProcessId; ' +
    'if ($_.CreationDate -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -eq $want[$id]) { try { $held[$id].Kill() } catch {} } } }'
  );
}

/**
 * The Windows host over `run`: PowerShell lists the processes and ends listed ones by id and start (`killScript`);
 * `taskkill /F /T` is only the fallback with no list. A failed call ends nothing.
 */
export function windowsSweepHostOf(run: HostRun, now: () => number = () => Date.now()): SweepHost {
  return {
    list: async () => {
      const printed = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT]);
      return printed === undefined ? undefined : parseStartedProcesses(printed);
    },
    kill: async (targets) => {
      if (targets.length > 0) {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', killScript(targets)]);
      }
    },
    killTree: async (root) => {
      await run('taskkill', ['/F', '/T', ...pidArgs([root])]);
    },
    now,
  };
}

/** The real Windows host. */
export const windowsSweepHost: SweepHost = windowsSweepHostOf(runOnHost);

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
