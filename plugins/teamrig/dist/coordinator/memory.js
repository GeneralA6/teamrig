import { execFile } from 'node:child_process';
import { freemem } from 'node:os';
const MB = 2 ** 20;
/** Bytes a process list may print: a host with thousands of processes stays far under it. */
const LIST_MAX_BUFFER = 16 * MB;
/** A timer that does not keep the process alive. */
export const nodeEvery = (ms, tick) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
};
/** The process `root` and every descendant still running, by parent links; empty when `root` is not listed. */
export function treeOf(root, rows) {
    const children = new Map();
    for (const row of rows) {
        if (row.pid !== row.parent) {
            children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
        }
    }
    const tree = rows.filter((row) => row.pid === root);
    const seen = new Set(tree.map((row) => row.pid));
    for (let index = 0; index < tree.length; index += 1) {
        for (const child of children.get(tree[index]?.pid ?? -1) ?? []) {
            if (!seen.has(child.pid)) {
                seen.add(child.pid);
                tree.push(child);
            }
        }
    }
    return tree;
}
/** The MB the tree of `root` holds; 0 when `root` is not listed. */
export function treeMb(root, rows) {
    return Math.round(treeOf(root, rows).reduce((total, row) => total + row.bytes, 0) / MB);
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
/** Rows of `<pid>,<parent>,<bytes>` lines; a line that is not three whole numbers is left out. */
export function parseProcessRows(text) {
    return text.split(/\r?\n/).flatMap((line) => {
        const cells = line.trim().split(/[,\s]+/).map(Number);
        const [pid, parent, bytes] = cells;
        return cells.length === 3 && pid !== undefined && parent !== undefined && bytes !== undefined && cells.every(Number.isSafeInteger) ? [{ pid, parent, bytes }] : [];
    });
}
/** Win32_Process lists every process with its parent and working set; `ps` prints the resident set in KB. */
function listCommand(platform) {
    if (platform === 'win32') {
        const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize }";
        return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], bytesPerUnit: 1 };
    }
    return { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss='], bytesPerUnit: 1024 };
}
/**
 * The real probe: Node's free memory, and the host's process list from PowerShell on Windows or `ps` elsewhere. The
 * lister and every process it started are left out, so a watch does not count its own sampling.
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
                const rows = parseProcessRows(stdout).map((row) => ({ ...row, bytes: row.bytes * bytesPerUnit }));
                const own = new Set(lister.pid === undefined ? [] : treeOf(lister.pid, rows).map((row) => row.pid));
                resolve(rows.filter((row) => !own.has(row.pid)));
            });
        }),
    };
}
/** The real host memory: the node probe, its watches timed by `nodeEvery`. */
export function nodeHostMemory(platform) {
    const probe = nodeMemoryProbe(platform);
    return { freeMb: () => probe.freeMb(), watch: (root, intervalMs) => watchMemory(probe, root, intervalMs, nodeEvery) };
}
