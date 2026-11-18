import { errorMessage } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { LockBusyError } from "../core/lock.js";
import { fileLockOf } from "./file-locks.js";
import { readIdlePassState } from "./idle-pass-check.js";
import { formatIdlePassState, IDLE_ACT_HOLD_MS, IDLE_PASS_EVERY_MS } from "./idle-pass-log.js";
import { closedOf, SessionLog } from "../sessions/log.js";
import { SessionRecordStore } from "../sessions/record.js";
/**
 * After a wake ask was posted for `id` on the team of `kit`: starts the reopen of a session teamrig closed, as one
 * pass would, or says why it stays closed. A reopen that cannot start is `closed` with why; it never throws.
 */
export async function wakeClosedSession(runtime, kit, config, roster, id) {
    try {
        const closed = closedOf((await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records, id);
        if (closed === undefined || !(await closedByTeamrig(runtime, kit, id))) {
            return { kind: 'open' };
        }
        const { mode } = config.open.idle;
        if (mode !== 'on') {
            return { kind: 'closed', why: `open.idle.mode is ${mode}, so the idle pass reopens nothing` };
        }
        const folder = closed.folder;
        if (folder === undefined) {
            return { kind: 'closed', why: 'its close names no folder to reopen it in; the idle pass reopens it' };
        }
        // Loaded only for a closed session: the pass's room check pulls in the pass and the hooks need neither.
        const { reopenHoldOf } = await import("./idle-pass.js");
        const hold = await reopenHoldOf(runtime, kit, config, roster, folder, id);
        if (hold !== undefined) {
            return { kind: 'closed', why: hold };
        }
        return await startReopenOnce(runtime, kit, config, id, folder);
    }
    catch (error) {
        if (error instanceof LockBusyError) {
            return { kind: 'closed', why: 'the idle pass holds its lock now, and that pass or the next reopens it for the line' };
        }
        return { kind: 'closed', why: `its state could not be read (${errorMessage(error)})` };
    }
}
/**
 * Starts `idle-open` for `id` once: under the idle pass's lock it takes the pass's own pending mark for the session
 * (src/cli/idle-pass-log.ts `heldActs`), so two wakes close together, or a wake beside a pass, never open two tabs of
 * one session. A reopen already pending under `IDLE_ACT_HOLD_MS` starts none; the closed state is read again under
 * the lock, as a reopen that ran meanwhile leaves the session open.
 */
async function startReopenOnce(runtime, kit, config, id, folder) {
    return fileLockOf(runtime, kit.paths.idlePassLock, config.lock).run(async () => {
        const now = runtime.clock.now();
        const state = await readIdlePassState(runtime.files, kit.paths);
        const mark = state?.pending?.[id];
        if (mark !== undefined && now >= mark.at && now - mark.at < IDLE_ACT_HOLD_MS) {
            // The pass marks its closes pending too, and takes no second act on a session while one is: a pending close is
            // no reopen under way, so it is said as it is.
            return mark.act === 'reopen' ? { kind: 'reopening', already: true } : { kind: 'closed', why: 'its close a moment ago is still settling' };
        }
        if (!(await closedByTeamrig(runtime, kit, id))) {
            return { kind: 'open' };
        }
        const started = await runtime.processes.startHidden({
            command: runtime.self.node,
            args: [runtime.self.script, 'idle-open', id, '--team', kit.paths.team, '--project', folder],
            cwd: folder,
            env: runtime.env,
        });
        if (started.kind !== 'started') {
            return { kind: 'closed', why: `its reopen did not start (${started.kind === 'missing' ? 'node was not found' : started.error})` };
        }
        // With no pass yet, the state starts a pass interval back, so the next check still runs one.
        const base = state ?? { at: now - IDLE_PASS_EVERY_MS, kinds: {} };
        await runtime.files.write(kit.paths.idlePass, formatIdlePassState({ ...base, pending: { ...base.pending, [id]: { act: 'reopen', at: now } } }));
        return { kind: 'reopening' };
    });
}
/**
 * Whether teamrig closed `id`, so no tab of it takes a wake ask: its session log's newest record is a close, and no
 * tab of it was started by hand since (its session record is newer), as the closed-send hold reads it.
 */
export async function closedByTeamrig(runtime, kit, id) {
    try {
        const closed = closedOf((await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records, id);
        if (closed === undefined) {
            return false;
        }
        const started = await new SessionRecordStore(runtime.files, kit.paths).read(id);
        return started === undefined || Date.parse(started.at) <= Date.parse(closed.at);
    }
    catch {
        return false;
    }
}
/** The line a timed wake (`--wake-by`) of a closed session gets: the line waits, and the idle pass reopens it once due. */
export function closedTimedWakeLine(label, id, clock) {
    return `CLOSED: ${label} is closed, so this line waits: the idle pass reopens it for the line once it is due (${clock}) and the host has room, or run: ${KIT_NAME} open ${id}`;
}
/** The line a sender is shown for a closed session's wake, never WAKES; undefined for an open one. */
export function closedWakeLine(wake, label, id) {
    switch (wake.kind) {
        case 'open':
            return undefined;
        case 'reopening':
            return wake.already === true
                ? `REOPENS ${label}: it was closed, and its reopen started a moment ago is still under way, so none started for this line; it opens once the host has room, the idle pass log saying REOPENED or KEPT with why (or run: ${KIT_NAME} open ${id})`
                : `REOPENS ${label}: it was closed, and its reopen started now for this line; it opens once the host has room, the idle pass log saying REOPENED or KEPT with why (or run: ${KIT_NAME} open ${id})`;
        case 'closed':
            return `CLOSED: ${label} was not woken: ${wake.why}; the idle pass tries again each minute, or run: ${KIT_NAME} open ${id}`;
    }
}
