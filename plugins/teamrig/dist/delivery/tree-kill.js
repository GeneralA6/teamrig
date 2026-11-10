import { execFile } from 'node:child_process';
import { treeOf, wholeNumberTriples } from "./processes.js";
/** The most list-and-kill rounds a sweep makes: each round ends one more generation, started before its parent ended. */
export const SWEEP_ROUNDS = 5;
/** How often a sweep tries its first list: a list can time out on a loaded host, and without one nothing is ended. */
export const LIST_TRIES = 2;
/** Bounds a process list or a kill, so a hung one cannot hold a timed-out step forever. */
const HOST_CALL_TIMEOUT_MS = 30_000;
/** Bytes a process list may print: a host with thousands of processes stays far under it. */
const LIST_MAX_BUFFER = 16 * 2 ** 20;
/**
 * The processes the last kill missed: a member it did not end (same id, same start), and the tree of each process
 * a member started (its parent is a member) before the kill ended. A process whose parent id is now held by a
 * different live process, or that started after the kill ended, is a stranger behind a reused id and is left alone.
 */
export function stragglersOf(rows, members, killedAtMs) {
    const liveStart = new Map(rows.map((row) => [row.pid, row.startedMs]));
    const parentIsMember = (row) => {
        const memberStart = members.get(row.parent);
        const parentStart = liveStart.get(row.parent);
        return memberStart !== undefined && (parentStart === undefined || parentStart === memberStart);
    };
    const seeds = rows.filter((row) => (members.has(row.pid) ? members.get(row.pid) === row.startedMs : parentIsMember(row) && row.startedMs <= killedAtMs));
    const found = new Map();
    for (const seed of seeds) {
        for (const row of treeOf(seed.pid, rows)) {
            found.set(row.pid, row);
        }
    }
    return [...found.values()];
}
/** The host's processes from the first list that works, of at most `LIST_TRIES`; undefined when none did. */
async function firstList(host) {
    for (let tries = 0; tries < LIST_TRIES; tries += 1) {
        const rows = await host.list();
        if (rows !== undefined) {
            return rows;
        }
    }
    return undefined;
}
/**
 * Ends the tree of `root` on Windows. The sweep lists the host, ends exactly the tree's listed processes, then lists
 * again and ends the stragglers, until a list finds none or `rounds` run out. It never runs `taskkill /T`: that walk
 * links a process to any older one that held its parent's id, with no start check, so a root that reused the id of a
 * long-ended process ends every program that one started; a Windows Terminal started so lost every tab (T2336). It
 * also misses a process started during the walk. Ending only listed processes, every ended process is a member, so an
 * orphan always has a member parent and the next list finds it. With no first list it ends nothing (`unlisted`): the
 * caller that holds the root's process can end that alone. When a later list fails it stops: killing the last ids
 * again without a fresh list could end a stranger that took one of them.
 */
export async function sweepTree(root, host, rounds = SWEEP_ROUNDS) {
    const first = await firstList(host);
    if (first === undefined) {
        return 'unlisted';
    }
    const members = new Map();
    let targets = treeOf(root, first);
    if (targets.length === 0) {
        return 'gone';
    }
    for (let round = 0; round < rounds && targets.length > 0; round += 1) {
        for (const target of targets) {
            members.set(target.pid, target.startedMs);
        }
        await host.kill(targets);
        const killedAtMs = host.now();
        const rows = await host.list();
        if (rows === undefined) {
            return 'swept';
        }
        targets = stragglersOf(rows, members, killedAtMs);
    }
    return 'swept';
}
/** Rows of `<pid>,<parent>,<startedMs>` lines; a line that is not three whole numbers is left out. */
export function parseStartedProcesses(text) {
    return wholeNumberTriples(text).map(([pid, parent, startedMs]) => ({ pid, parent, startedMs }));
}
/** Win32_Process with each start as Unix ms; a process with no start (the idle and system ones) prints 0. */
const LIST_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { ' +
    "'{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) }";
const runOnHost = (file, args) => new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: LIST_MAX_BUFFER, timeout: HOST_CALL_TIMEOUT_MS }, (error, stdout) => resolve(error === null ? stdout : undefined));
});
/**
 * Ends each target only while its id still names the process the list saw. Windows hands a freed id to the next new
 * process within milliseconds and a list takes about a second, so a listed process that ended by itself meanwhile (a
 * console host whose shell was just killed) can be another program by the kill, which `taskkill /PID` would end
 * (T1562). The script first opens a handle to each target, which holds its id, then reads their starts through the
 * list's own Win32_Process query and ends, through that handle, only a held process whose start is the listed one; a
 * process with no start is never ended. A target that ended or cannot be opened is skipped; the next list finds any
 * member it missed.
 */
export function killScript(targets) {
    const wanted = targets.map((target) => `${target.pid} = ${target.startedMs}`).join('; ');
    return (`$want = @{ ${wanted} }; $held = @{}; ` +
        'foreach ($id in @($want.Keys)) { try { $p = Get-Process -Id $id -ErrorAction Stop; $null = $p.Handle; $held[$id] = $p } catch {} }; ' +
        'if ($held.Count -gt 0) { ' +
        "Get-CimInstance Win32_Process -Filter ((@($held.Keys) | ForEach-Object { \"ProcessId=$_\" }) -join ' OR ') | ForEach-Object { " +
        '$id = [int]$_.ProcessId; ' +
        'if ($_.CreationDate -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -eq $want[$id]) { try { $held[$id].Kill() } catch {} } } }');
}
/**
 * The Windows host over `run`: PowerShell lists the processes and ends listed ones by id and start (`killScript`). A
 * failed call ends nothing.
 */
export function windowsSweepHostOf(run, now = () => Date.now()) {
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
        now,
    };
}
/** The real Windows host. */
export const windowsSweepHost = windowsSweepHostOf(runOnHost);
/**
 * On Windows the sweep ends the tree: killing only the shell would leave the command it started running. When the host
 * cannot be listed, the held process alone is ended through its handle: what it started runs on, but no id walk can
 * reach a stranger. On POSIX the step runs as its own process group, and the group is killed; an orphan stays in its
 * group.
 */
export function nodeTreeKill(platform, host = windowsSweepHost) {
    if (platform === 'win32') {
        return async (held) => {
            if (held.pid !== undefined && (await sweepTree(held.pid, host)) === 'unlisted') {
                held.kill('SIGKILL');
            }
        };
    }
    return (held) => {
        if (held.pid !== undefined) {
            try {
                process.kill(-held.pid, 'SIGKILL');
            }
            catch {
                // The group ended on its own between the timer and the kill.
            }
        }
        return Promise.resolve();
    };
}
