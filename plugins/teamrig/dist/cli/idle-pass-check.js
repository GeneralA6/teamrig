import { idlePassTrouble, parseIdlePassState } from "./idle-pass-log.js";
import { idlePassWarning } from "./unowned.js";
/** The team's idle pass state (`state/idle-pass.json`); undefined with no pass yet or a damaged file. */
export async function readIdlePassState(files, paths) {
    return parseIdlePassState((await files.read(paths.idlePass)) ?? '');
}
/**
 * FLEET-STALE (T1100), for `check`: while `open.idle.mode` is not off, a pass that has not run for
 * `IDLE_PASS_STALE_MS`, or whose last run failed, closes and reopens no one, so it is a warning no session owns and
 * goes to the lead. With mode off it reads nothing.
 */
export async function idlePassWarnings(files, paths, mode, now) {
    if (mode === 'off') {
        return [];
    }
    const trouble = idlePassTrouble(await readIdlePassState(files, paths), now);
    return trouble === undefined ? [] : [idlePassWarning(trouble, mode, now)];
}
