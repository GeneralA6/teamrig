import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { treeOf, wholeNumberLines } from "./processes.js";
const MB = 2 ** 20;
/** Bytes a process list may print: a host with thousands of processes stays far under it. */
const LIST_MAX_BUFFER = 16 * MB;
/** How many of the programs holding the most memory a refusal names. */
export const TOP_HOLDERS = 3;
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
    const startFreeMb = probe.freeMb();
    let lowFreeMb = startFreeMb;
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
            return peakTreeMb === undefined ? { lowFreeMb, startFreeMb } : { peakTreeMb, lowFreeMb, startFreeMb };
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
/** A `<memory> <name>` or `<memory>,<name>` line of a named process list. */
const HOLDER_LINE = /^\s*(\d+)(?:,|\s+)(.*\S)\s*$/;
/**
 * A process's program as a holder names it: the last part of a full path (`ps` on macOS prints one) and no `.exe`. A
 * name with a slash that is no path, such as Linux's `kworker/0:1`, stays whole.
 */
function programOf(listed) {
    const program = listed.startsWith('/') ? listed.slice(listed.lastIndexOf('/') + 1) : listed;
    return program.replace(/\.exe$/i, '');
}
/**
 * The programs a named process list holds memory in, most first (then by name), each process's memory, in the
 * lister's unit (`bytesPerUnit` bytes), summed by program; a line that is not a whole number and a name is left out.
 */
export function parseHolders(text, bytesPerUnit) {
    const held = new Map();
    for (const line of text.split(/\r?\n/)) {
        const match = HOLDER_LINE.exec(line);
        const amount = Number(match?.[1]);
        const listed = match?.[2];
        if (listed === undefined || !Number.isSafeInteger(amount)) {
            continue;
        }
        const name = programOf(listed);
        const sum = held.get(name) ?? { bytes: 0, processes: 0 };
        held.set(name, { bytes: sum.bytes + amount * bytesPerUnit, processes: sum.processes + 1 });
    }
    return [...held]
        .map(([name, sum]) => ({ name, mb: Math.round(sum.bytes / MB), processes: sum.processes }))
        .sort((a, b) => b.mb - a.mb || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/** `mb` as a person reads it: GB with one decimal from 1 GB, else MB. */
function sizeText(mb) {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
/** The first `count` of `holders` as a refusal names them, such as `top memory holders: vmmem 22.4 GB, msedge 20.9 GB in 35 processes`; undefined for none. */
export function holdersText(holders, count = TOP_HOLDERS) {
    const named = holders.slice(0, count).map((holder) => `${holder.name} ${sizeText(holder.mb)}${holder.processes > 1 ? ` in ${holder.processes} processes` : ''}`);
    return named.length === 0 ? undefined : `top memory holders: ${named.join(', ')}`;
}
/**
 * Lists every process's working set (resident memory) and program name: Win32_Process in bytes, `ps` in KB. Apart
 * from `listCommand`, whose whole-number lines every watch sample parses.
 */
function namedListCommand(platform) {
    if (platform === 'win32') {
        const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1}' -f $_.WorkingSetSize,$_.Name }";
        return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], bytesPerUnit: 1 };
    }
    // On Linux `comm` is the main thread's name, which a program may set: Node 24 names its own `MainThread`, so every
    // node process would hold memory under that name. The command line's first word names the program instead.
    return { file: 'ps', args: ['-A', '-o', platform === 'linux' ? 'rss=,args=' : 'rss=,comm='], bytesPerUnit: 1024 };
}
/**
 * A Linux `<rss> <command line>` list as `<rss> <program>` lines: the command line's first word, and a kernel
 * thread's bracketed name (`[kworker/0:1]`) without its brackets. A line with no command line is left out.
 */
export function linuxProgramLines(text) {
    const lines = [];
    for (const line of text.split('\n')) {
        const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
        const amount = match?.[1];
        const commandLine = match?.[2];
        if (amount === undefined || commandLine === undefined) {
            continue;
        }
        const kernel = /^\[(.+)\]$/.exec(commandLine.trim());
        const program = kernel?.[1] ?? commandLine.split(/\s+/)[0] ?? commandLine;
        lines.push(`${amount} ${program}`);
    }
    return lines.join('\n');
}
/** The host's programs by the memory they hold; undefined when the list fails. The lister itself is counted: a few dozen MB. */
async function holdersOf(platform) {
    const { file, args, bytesPerUnit } = namedListCommand(platform);
    const text = await outputOf(file, args);
    if (text === undefined) {
        return undefined;
    }
    return parseHolders(platform === 'linux' ? linuxProgramLines(text) : text, bytesPerUnit);
}
/** What `file` printed, or undefined when it failed. */
function outputOf(file, args) {
    return new Promise((resolve) => {
        execFile(file, args, { windowsHide: true, maxBuffer: LIST_MAX_BUFFER }, (error, stdout) => resolve(error === null ? stdout : undefined));
    });
}
/** The commit charge: Win32_OperatingSystem on Windows, `/proc/meminfo` on Linux under strict overcommit, nothing elsewhere. */
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
        return linuxCommitOf(await readFile('/proc/sys/vm/overcommit_memory', 'utf8'), await readFile('/proc/meminfo', 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * Linux's commit charge, read only under strict overcommit (`vm.overcommit_memory` 2), the one mode in which the
 * kernel refuses memory past CommitLimit. Under the default heuristic (0) and always (1) modes Committed_AS passes the
 * limit on a busy host without harm, so a gate on it would hold every queued step on such a host for good (#599);
 * the free-memory check still guards those hosts.
 */
export function linuxCommitOf(overcommitMode, meminfo) {
    return overcommitMode.trim() === '2' ? parseMeminfoCommit(meminfo) : undefined;
}
/**
 * The real probe: Node's free and total memory, the host's process list from PowerShell on Windows or `ps` elsewhere, and its
 * commit charge. The lister and every process it started are left out, so a watch does not count its own sampling.
 */
export function nodeMemoryProbe(platform) {
    const { file, args, bytesPerUnit } = listCommand(platform);
    return {
        freeMb: () => Math.round(freemem() / MB),
        totalMb: () => Math.round(totalmem() / MB),
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
/** The real host memory: the node probe, its watches timed by `nodeEvery`, and the host's named process list. */
export function nodeHostMemory(platform) {
    const probe = nodeMemoryProbe(platform);
    return { ...probe, watch: (root, intervalMs) => watchMemory(probe, root, intervalMs, nodeEvery), holders: () => holdersOf(platform) };
}
