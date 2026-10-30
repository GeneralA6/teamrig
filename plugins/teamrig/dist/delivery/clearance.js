import { holderText, waitText } from "./host-lock.js";
/**
 * Takes the host lock once nothing holds the step back. A refusal ends the wait at once; a reason to wait and a busy
 * lock are waited out, for at most `maxWaitMs` in all, the lock longer while its line moves (see `HostLock.acquire`).
 * Readiness is asked again under the lock, since a freeze may start while the step waited for the lock: then the lock
 * is released and the wait goes on. Each ask names its phase, so a check that costs or changes something can run
 * only under the lock.
 */
export async function takeWhenClear(readiness, ports, request) {
    const { lock, clock, sleep } = ports;
    const deadline = clock.now() + request.maxWaitMs;
    let told;
    /** Logs a new reason and sleeps one poll; false when the wait has run out. */
    const hold = async (reason) => {
        if (reason !== told) {
            request.onWait(reason);
            told = reason;
        }
        const left = deadline - clock.now();
        if (left <= 0) {
            return false;
        }
        await sleep(Math.min(request.pollMs, left));
        return true;
    };
    for (;;) {
        const before = await readiness('before');
        if (before.kind === 'refuse') {
            return { kind: 'refused', reason: before.reason };
        }
        if (before.kind === 'wait') {
            if (!(await hold(before.reason))) {
                return { kind: 'gaveUp', reason: before.reason };
            }
            continue;
        }
        const taking = await lock.acquire(request.session, request.purpose, Math.max(0, deadline - clock.now()), request.pollMs, (holder, ahead) => request.onWait(`the host lock: ${waitText(holder, ahead, request.zone)}`));
        if (taking.kind === 'busy') {
            return { kind: 'gaveUp', reason: `host lock still held by ${holderText(taking.holder, request.zone)}` };
        }
        if (taking.kind === 'withdrawn') {
            return { kind: 'refused', reason: "withdrawn from the host lock's line (teamrig withdraw)" };
        }
        const under = await readiness('locked');
        if (under.kind === 'go') {
            return { kind: 'taken', lock: taking.lock };
        }
        await lock.release(taking.lock);
        told = undefined;
        if (under.kind === 'refuse') {
            return { kind: 'refused', reason: under.reason };
        }
        if (!(await hold(under.reason))) {
            return { kind: 'gaveUp', reason: under.reason };
        }
    }
}
