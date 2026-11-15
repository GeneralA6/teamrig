import { resolveReset } from "../budget/pace.js";
import { weekUseAt } from "../budget/snapshot.js";
import { readFolderWeek } from "../budget/week-summary.js";
import { CpuGate } from "../delivery/cpu.js";
import { FREEZES_LOCK_TTL_MS } from "../delivery/freeze-store.js";
import { HostLock } from "../delivery/host-lock.js";
import { MemoryGate } from "../delivery/memory-gate.js";
import { PIPELINE_FREEZES_LOCK_TTL_MS } from "../delivery/pipeline-freezes.js";
import { TabHolds, tabHoldsDir } from "../sessions/tab-holds.js";
const MINUTE_MS = 60_000;
/**
 * Progress lines, each stamped with the time on the team's clock to the second (`2030-01-08 12:00:05 IST running: …`),
 * since a delivery command mostly runs in the background with its output in a log.
 */
export function logLineOf(runtime, zone) {
    return (text) => runtime.out.stdout(`${zone.second(new Date(runtime.clock.now()))} ${text}`);
}
/**
 * The host lock at `path`, held by this process for `delivery.queue.lockTtlMinutes`; a holder whose process ended is
 * stale. Every step that takes it or shares the host passes its memory gate first: free memory over
 * `delivery.queue.memoryFloorMb` plus the step's reserve (`heavyReserveMb` at least for a step that takes the lock),
 * and the commit charge under `open.headroom.commitMaxPct` with the reserve counted, the tabs still loading beside the
 * lock (`tabHoldsDir(path)`, written by `open`) holding their MB of both. Its line is ordered by the rules `admission`
 * gives at each look ({@link teamAdmissionOf}); a heavy step joins another
 * heavy one only while `delivery.queue.heavyIdleCpuPct` of the host's CPU is idle. A waiter's ticket says what it waits
 * on with the times on `zone`'s clock.
 */
export function hostLockOf(runtime, path, queue, headroom, admission, zone) {
    const tabs = new TabHolds(tabHoldsDir(path), runtime);
    const memory = new MemoryGate(runtime.memory, runtime.sleep, { floorMb: queue.memoryFloorMb, heavyReserveMb: queue.heavyReserveMb, commitMaxPct: headroom.commitMaxPct }, () => tabs.live());
    const cpu = new CpuGate(runtime.cpu, runtime.sleep, queue.heavyIdleCpuPct);
    return lockAt(runtime, path, queue.lockTtlMinutes * MINUTE_MS, zone, { memory, cpu, admission });
}
/** The rules the host lock's line is ordered by: `delivery.queue.admission` and its keys, a ticket naming no class counting as `focus.defaultClass`. */
export function admissionRulesOf(queue, focus) {
    return {
        mode: queue.admission,
        agingMinutes: queue.agingMinutes,
        memoryPassMinutes: queue.memoryPassMinutes,
        perSessionRunning: queue.perSessionRunning,
        maxHeavyParallel: queue.maxHeavyParallel,
        defaultClass: focus.defaultClass,
    };
}
/**
 * The admission rules of the team's config as `reload` reads it at each look, starting from `config`'s, the one the
 * command launched on (T2942): a step waits in line for hours, and one that kept its launch's rules never saw a
 * raised `maxHeavyParallel`. A read that finds no config, or one that does not parse (mid-edit), keeps the last rules
 * read, so a bad edit never reorders the line.
 */
export function teamAdmissionOf(config, reload) {
    let last = admissionRulesOf(config.delivery.queue, config.focus);
    return {
        async rules() {
            const load = await reload();
            if (load.status === 'loaded') {
                last = admissionRulesOf(load.config.delivery.queue, load.config.focus);
            }
            return last;
        },
    };
}
/**
 * The lock the deploy freezes' writers share at `path`, held for a minute, since a write takes moments; it guards no
 * step, so no memory gate, and its line stays in arrival order.
 */
export function freezesLockOf(runtime, path, zone) {
    return lockAt(runtime, path, FREEZES_LOCK_TTL_MS, zone, {});
}
/** The lock on the pipeline freezes at `path`, held for one read and write: like the deploy freezes' lock, no memory gate. */
export function pipelineFreezesLockOf(runtime, path, zone) {
    return lockAt(runtime, path, PIPELINE_FREEZES_LOCK_TTL_MS, zone, {});
}
function lockAt(runtime, path, ttlMs, zone, gates) {
    return new HostLock(path, ttlMs, {
        files: runtime.files,
        clock: runtime.clock,
        sleep: runtime.sleep,
        pid: runtime.pid,
        alive: (pid) => runtime.sessionProcesses.alive(pid),
        newId: () => runtime.newId(),
        zone,
        ...gates,
    });
}
/** The next weekly token reset at each check: the one the status line last reported, else the one `budget.reset` sets; undefined when neither says. */
export function nextResetFrom(runtime, budget, snapshotDir) {
    return async (nowMs) => {
        const fromStatus = weekUseAt(await readFolderWeek(runtime.files, snapshotDir, nowMs), nowMs)?.resetsAt;
        const at = resolveReset(nowMs, fromStatus, budget.reset);
        if (at === undefined) {
            return undefined;
        }
        return { at, source: at === fromStatus ? 'status line' : 'budget.reset config' };
    };
}
