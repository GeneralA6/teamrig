// A leaf module with no import: admission.ts is on the read side (src/read), which must reach no node: module, and
// wait-log.ts reaches host-lock.ts and through it the host's files and memory readers.

/**
 * Why a queued step waited, as its start record sums it: the host lock held by another step (`lock`), an earlier waiter
 * the free lock goes to first (`line`), the steps sharing the host ending before a step that took the lock runs
 * (`draining`), the host's free memory or commit charge too short (`memory`, `commit`), a deploy freeze (`freeze`), a
 * deploy check holding the step (`check`), its own session running its cap of steps (`session`, T2210), or the heavy
 * steps sharing the host at their cap (`heavyCap`, T2210), the host's CPU too busy for one more heavy step (`cpu`,
 * T2700), or, for a step that moves a main branch, another such step holding the host's one ship slot (`shipSlot`,
 * T2727). A new cause goes at the end: a reader of the ledger skips a cause it does not know.
 */
export const WAIT_CAUSES = ['lock', 'line', 'draining', 'memory', 'commit', 'freeze', 'check', 'session', 'heavyCap', 'cpu', 'shipSlot'] as const;

export type WaitCause = (typeof WAIT_CAUSES)[number];
