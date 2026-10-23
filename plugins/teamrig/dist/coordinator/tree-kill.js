import { execFile } from 'node:child_process';
import { treeOf, wholeNumberTriples } from "./processes.js";
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
/**
 * Ends the tree of `root` on Windows. The sweep lists the host, ends exactly the tree's listed processes, then lists
 * again and ends the stragglers, until a list finds none or `rounds` run out. It never kills a listed tree with
 * `taskkill /T`: that walks parent links once and also ends processes the sweep never listed, so a process one of
 * those started during the walk would run on under a parent the sweep never knew. Ending only listed processes, every
 * ended process is a member, so an orphan always has a member parent and the next list finds it. With no first list
 * it falls back to one `taskkill /T` of the root. When a later list fails it stops: killing the last ids again
 * without a fresh list could end a stranger that took one of them.
 */
export async function sweepTree(root, host, rounds = SWEEP_ROUNDS) {
    const first = await host.list();
    if (first === undefined) {
        await host.killTree(root);
        return;
    }
    const members = new Map();
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
export function parseStartedProcesses(text) {
    return wholeNumberTriples(text).map(([pid, parent, startedMs]) => ({ pid, parent, startedMs }));
}
/** Win32_Process with each start as Unix ms; a process with no start (the idle and system ones) prints 0. */
const LIST_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { ' +
    "'{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) }";
const runOnHost = (file, args) => new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: LIST_MAX_BUFFER, timeout: HOST_CALL_TIMEOUT_MS }, (error, stdout) => resolve(error === null ? stdout : undefined));
});
/** `/PID <id>` for each process, as taskkill takes them. */
const pidArgs = (pids) => pids.flatMap((pid) => ['/PID', String(pid)]);
/** The Windows host over `run`: PowerShell lists the processes, `taskkill /F` ends them; a failed call ends nothing. */
export function windowsSweepHostOf(run, now = () => Date.now()) {
    return {
        list: async () => {
            const printed = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT]);
            return printed === undefined ? undefined : parseStartedProcesses(printed);
        },
        // taskkill exits non-zero when one of the processes had already ended; the next list finds any it missed.
        kill: async (pids) => {
            await run('taskkill', ['/F', ...pidArgs(pids)]);
        },
        killTree: async (root) => {
            await run('taskkill', ['/F', '/T', ...pidArgs([root])]);
        },
        now,
    };
}
/** The real Windows host. */
export const windowsSweepHost = windowsSweepHostOf(runOnHost);
/**
 * On Windows the sweep ends the tree: killing only the shell would leave the command it started running, and one
 * `taskkill /T` can miss a process started while it runs. On POSIX the step runs as its own process group, and the
 * group is killed; an orphan stays in its group.
 */
export function nodeTreeKill(platform, host = windowsSweepHost) {
    if (platform === 'win32') {
        return (pid) => sweepTree(pid, host);
    }
    return (pid) => {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch {
            // The group ended on its own between the timer and the kill.
        }
        return Promise.resolve();
    };
}
