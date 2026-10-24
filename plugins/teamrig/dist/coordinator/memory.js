import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { treeOf, wholeNumberLines } from "./processes.js";
const MB = 2 ** 20;
/** Bytes a process list may print: a host with thousands of processes stays far under it. */
const LIST_MAX_BUFFER = 16 * MB;
/** A timer that does not keep the process alive. */
export const nodeEvery = (ms, tick) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
};
/** The MB the tree of `root` holds; 0 when `root` is not listed. */
export function treeMb(root, rows) {
    return Math.round(treeOf(root, rows).reduce((total, row) => total + row.bytes, 0) / MB);
}
/** The MB the tree of `root` has committed; undefined when a process of it is listed without it (a `ps` list). */
export function treeCommittedMb(root, rows) {
    let total = 0;
    for (const row of treeOf(root, rows)) {
        if (row.committed === undefined) {
            return undefined;
        }
        total += row.committed;
    }
    return Math.round(total / MB);
}
/**
 * Watches the tree of `root`: a sample now and every `intervalMs`, a tick skipped while the last sample still runs
 * (a slow process list never piles up), and one last look at free memory when stopped.
 */
export function watchMemory(probe, root, intervalMs, every) {
    let peakTreeMb;
    let lowFreeMb = probe.freeMb();
    let inFlight;
    const sample = async () => {
        lowFreeMb = Math.min(lowFreeMb, probe.freeMb());
        const rows = await probe.processes();
        if (rows !== undefined) {
            peakTreeMb = Math.max(peakTreeMb ?? 0, treeMb(root, rows));
        }
    };
    const tick = () => {
        if (inFlight === undefined) {
            inFlight = sample().finally(() => {
                inFlight = undefined;
            });
        }
    };
    tick();
    const cancel = every(intervalMs, tick);
    return {
        async stop() {
            cancel();
            await inFlight;
            lowFreeMb = Math.min(lowFreeMb, probe.freeMb());
            return peakTreeMb === undefined ? { lowFreeMb } : { peakTreeMb, lowFreeMb };
        },
    };
}
/**
 * Rows of `<pid>,<parent>,<bytes>[,<started ms>[,<committed bytes>]]` lines; a line that is not three to five whole
 * numbers is left out.
 */
export function parseProcessRows(text) {
    return wholeNumberLines(text, [3, 4, 5]).flatMap(([pid, parent, bytes, startedMs, committed]) => {
        if (pid === undefined || parent === undefined || bytes === undefined) {
            return [];
        }
        return [{ pid, parent, bytes, ...(startedMs === undefined ? {} : { startedMs }), ...(committed === undefined ? {} : { committed }) }];
    });
}
/** A listed row with its memory in bytes, from the lister's unit (KB for `ps`). */
function inBytes(row, bytesPerUnit) {
    const bytes = row.bytes * bytesPerUnit;
    return row.committed === undefined ? { ...row, bytes } : { ...row, bytes, committed: row.committed * bytesPerUnit };
}
/** Win32_OperatingSystem's `<total>,<free>` virtual memory in KB: the commit limit, and what is left of it. */
export function parseWindowsCommit(text) {
    const cells = text.trim().split(',').map(Number);
    const [limitKb, freeKb] = cells;
    if (cells.length !== 2 || limitKb === undefined || freeKb === undefined || !cells.every(Number.isSafeInteger) || limitKb === 0 || freeKb > limitKb) {
        return undefined;
    }
    return { usedMb: Math.round((limitKb - freeKb) / 1024), limitMb: Math.round(limitKb / 1024) };
}
/** `/proc/meminfo`'s Committed_AS (used) and CommitLimit, in kB; undefined unless both are there and the limit is not 0. */
export function parseMeminfoCommit(text) {
    const kbOf = (key) => {
        const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
        return match?.[1] === undefined ? undefined : Number(match[1]);
    };
    const usedKb = kbOf('Committed_AS');
    const limitKb = kbOf('CommitLimit');
    return usedKb === undefined || limitKb === undefined || limitKb === 0 ? undefined : { usedMb: Math.round(usedKb / 1024), limitMb: Math.round(limitKb / 1024) };
}
/**
 * Win32_Process lists every process with its parent, working set, start and private bytes (`PrivatePageCount`, in
 * bytes despite its name); `ps` prints the resident set in KB and has no column for what a process committed.
 */
function listCommand(platform) {
    if (platform === 'win32') {
        const started = '$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 })';
        const script = `Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2},{3},{4}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,${started},$_.PrivatePageCount }`;
        return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], bytesPerUnit: 1 };
    }
    return { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss='], bytesPerUnit: 1024 };
}
/** What `file` printed, or undefined when it failed. */
function outputOf(file, args) {
    return new Promise((resolve) => {
        execFile(file, args, { windowsHide: true, maxBuffer: LIST_MAX_BUFFER }, (error, stdout) => resolve(error === null ? stdout : undefined));
    });
}
/** The commit charge: Win32_OperatingSystem on Windows, `/proc/meminfo` on Linux, nothing elsewhere. */
async function commitOf(platform) {
    if (platform === 'win32') {
        const script = "Get-CimInstance Win32_OperatingSystem | ForEach-Object { '{0},{1}' -f $_.TotalVirtualMemorySize,$_.FreeVirtualMemory }";
        const text = await outputOf('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        return text === undefined ? undefined : parseWindowsCommit(text);
    }
    if (platform !== 'linux') {
        return undefined;
    }
    try {
        return parseMeminfoCommit(await readFile('/proc/meminfo', 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * The real probe: Node's free memory, the host's process list from PowerShell on Windows or `ps` elsewhere, and its
 * commit charge. The lister and every process it started are left out, so a watch does not count its own sampling.
 */
export function nodeMemoryProbe(platform) {
    const { file, args, bytesPerUnit } = listCommand(platform);
    return {
        freeMb: () => Math.round(freemem() / MB),
        processes: () => new Promise((resolve) => {
            const lister = execFile(file, args, { windowsHide: true, maxBuffer: LIST_MAX_BUFFER }, (error, stdout) => {
                if (error !== null) {
                    resolve(undefined);
                    return;
                }
                const rows = parseProcessRows(stdout).map((row) => inBytes(row, bytesPerUnit));
                const own = new Set(lister.pid === undefined ? [] : treeOf(lister.pid, rows).map((row) => row.pid));
                resolve(rows.filter((row) => !own.has(row.pid)));
            });
        }),
        commit: () => commitOf(platform),
    };
}
/** The real host memory: the node probe, its watches timed by `nodeEvery`. */
export function nodeHostMemory(platform) {
    const probe = nodeMemoryProbe(platform);
    return { ...probe, watch: (root, intervalMs) => watchMemory(probe, root, intervalMs, nodeEvery) };
}
