/**
 * Free memory is read this many times, `READ_GAP_MS` apart, and the least read counts: a step that just ended gives
 * back its memory in a burst, and a step that just started takes it in one, so a single read can catch either.
 */
export const FREE_READS = 3;
export const READ_GAP_MS = 1_000;
/** `{ loading }` for the tabs that hold `mb`, or nothing when none load. */
function loadingOf(tabs, mb) {
    return tabs.length === 0 ? {} : { loading: { tabs: tabs.length, mb } };
}
/**
 * Whether the host has the memory for one more step: free memory over the floor plus the step's reserve, the
 * small steps' held MB counted as taken, and room under the commit limit for its reserve. The tabs still loading
 * (`loading`) hold their MB of both, as a tab opened just before the step shows in neither yet (T2199). A short first
 * read ends the look at once; the commit charge, a slow read on Windows (a PowerShell call), is read only once free
 * memory clears.
 */
export class MemoryGate {
    config;
    probe;
    sleep;
    loading;
    constructor(probe, sleep, config, loading) {
        this.probe = probe;
        this.sleep = sleep;
        this.config = config;
        this.loading = loading;
    }
    /** One look for a step that holds `reserveMb` beside the `heldMb` held for the small steps on the host and the tabs still loading. */
    async look(reserveMb, heldMb) {
        const { floorMb, commitMaxPct } = this.config;
        const tabs = await this.loading();
        const tabsMb = tabs.reduce((total, tab) => total + tab.needMb, 0);
        const hostMb = this.probe.totalMb();
        const capped = (floorMb + reserveMb) * 2 > hostMb;
        const needMb = capped ? Math.floor(hostMb / 2) : floorMb + reserveMb;
        let freeMb = this.probe.freeMb();
        for (let read = 1; freeMb - heldMb - tabsMb >= needMb; read += 1) {
            if (read === FREE_READS) {
                const commit = await this.probe.commit();
                const tabsCommittedMb = tabs.reduce((total, tab) => total + tab.needCommittedMb, 0);
                if (commit !== undefined && (commit.usedMb + tabsCommittedMb + reserveMb) * 100 > commitMaxPct * commit.limitMb) {
                    return { kind: 'commit', ...commit, maxPct: commitMaxPct, reserveMb, ...loadingOf(tabs, tabsCommittedMb) };
                }
                return { kind: 'room', freeMb };
            }
            await this.sleep(READ_GAP_MS);
            freeMb = Math.min(freeMb, this.probe.freeMb());
        }
        return { kind: 'memory', freeMb, heldMb, needMb, floorMb, reserveMb, ...(capped ? { hostMb } : {}), ...loadingOf(tabs, tabsMb) };
    }
}
/**
 * Why a step waits on the host's memory, as a session reads it, `sharing` the number of small steps the held MB is
 * for: `host memory: 6000 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)`, or
 * `host commit charge: 30000 of 32000 MB, 2048 MB more for this step would pass 92% (open.headroom.commitMaxPct)`.
 * A step's MB is followed by its basis, when it has one: `(4096 floor + 7500 for this step, learned from 12 runs)`.
 * The tabs still loading are named after the steps: `…, 1500 MB held for 1 tab still loading, …`.
 */
export function shortText(short, sharing) {
    const tabs = short.loading === undefined ? '' : `${short.loading.mb} MB held for ${tabsText(short.loading.tabs)} still loading`;
    if (short.kind === 'commit') {
        const basis = short.basis === undefined ? '' : ` (${short.basis})`;
        const held = tabs === '' ? '' : `${tabs} and `;
        return `host commit charge: ${short.usedMb} of ${short.limitMb} MB, ${held}${short.reserveMb} MB more for this step${basis} would pass ${short.maxPct}% (open.headroom.commitMaxPct)`;
    }
    const steps = sharing === 0 ? '' : `, ${short.heldMb} MB held for ${sharing === 1 ? 'it' : 'them'}`;
    const held = tabs === '' ? steps : `${steps}, ${tabs}`;
    const basis = short.basis === undefined ? '' : `, ${short.basis}`;
    const need = short.hostMb === undefined ? `${short.floorMb} floor + ${short.reserveMb} for this step${basis}` : `half the host's ${short.hostMb} MB`;
    return `host memory: ${short.freeMb} MB free${held}, ${short.needMb} MB needed (${need})`;
}
/** `1 tab`, `2 tabs`. */
export function tabsText(count) {
    return count === 1 ? '1 tab' : `${count} tabs`;
}
