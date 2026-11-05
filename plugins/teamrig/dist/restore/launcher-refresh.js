import { join } from 'node:path';
import { errorMessage, stringField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD } from "../core/jsonl.js";
import { LockBusyError } from "../core/lock.js";
import { compareVersions, parseVersion } from "../core/release-version.js";
import { launcherStep, restorePlan } from "./install-plan.js";
import { restoreLogPath } from "./registry.js";
/**
 * The launcher refresh at each session start: once per plugin version, it brings up to date what an install left on
 * the machine (install-plan.ts in refresh mode, plus the kit home's other launchers), so a plugin update never leaves
 * an old launcher, a logon entry or a pinned shortcut behind. The record `<kit home>/bin/launchers.json` names the
 * newest version that refreshed: a start reads it once, without the lock, and goes on only when it runs a newer
 * version, so every later start of that version costs that one read, and an older teamrig still running beside a newer
 * one writes nothing, so the two never take turns rewriting the launchers. The start that goes on takes the lock
 * without waiting, so the tabs of a restore starting together leave the refresh to one of them, reads the record again
 * under it, and takes the steps in order. Each step taken goes to the restore log; a failed one is logged and leaves
 * the record as it was, so the next session start tries again.
 */
/** The record's format; a field added to it raises this. */
export const LAUNCHER_RECORD_FORMAT = 1;
/**
 * The record's lock: a refresh spawns a few system commands (the logon entry and the shortcut scan), and a waiter
 * never waits, since the start that holds it does the same work.
 */
export const LAUNCHER_REFRESH_LOCK = { ttlMs: 120_000, pollMs: 50, waitMs: 0 };
/**
 * The record's lock as `restore install` and `restore uninstall` take it while they write: they wait out a refresh
 * another session start is taking, which ends or turns stale within the lock's TTL, so the two never interleave.
 */
export const LAUNCHER_INSTALL_LOCK = { ...LAUNCHER_REFRESH_LOCK, waitMs: LAUNCHER_REFRESH_LOCK.ttlMs };
/** The record of the newest version that refreshed the launchers: `<kit home>/bin/launchers.json`. */
export function launcherRecordPath(kitHome) {
    return join(kitHome, 'bin', 'launchers.json');
}
/** The record's text as `Recorded`. */
function recordedOf(text) {
    const record = text === undefined ? undefined : parseObject(text.trim());
    const format = record === undefined ? undefined : recordVersion(record);
    if (record === undefined || format === undefined) {
        return { kind: 'none' };
    }
    if (format > LAUNCHER_RECORD_FORMAT) {
        return { kind: 'newer-format' };
    }
    const versionText = stringField(record, 'version');
    const version = versionText === undefined ? undefined : parseVersion(versionText);
    return versionText === undefined || version === undefined ? { kind: 'none' } : { kind: 'version', text: versionText, version };
}
/** Whether `running` is newer than the version the record names: a record of no version is older, one of a newer format newer. */
function isDue(recorded, running) {
    switch (recorded.kind) {
        case 'none':
            return true;
        case 'newer-format':
            return false;
        case 'version':
            return compareVersions(running, recorded.version) > 0;
    }
}
/** Whether the record names a version newer than `running`: one of a newer format does, none does not. */
function namesNewer(recorded, running) {
    switch (recorded.kind) {
        case 'none':
            return false;
        case 'newer-format':
            return true;
        case 'version':
            return compareVersions(recorded.version, running) > 0;
    }
}
/**
 * The step that lowers the record to `version` before an install of that version writes the launchers: an older
 * teamrig on the PATH writes its older texts, and a record still naming a newer version would keep every later start
 * of that version from writing them back; lowered, the next start of a newer teamrig is due and refreshes. None when
 * the record names this version or an older one, when there is none (every start is due then, and install never
 * creates it), or when `version` is no release version, which the refresh never records either.
 */
export async function lowerRecordSteps(files, kitHome, version, now) {
    const running = parseVersion(version);
    const path = launcherRecordPath(kitHome);
    const recorded = recordedOf(await files.read(path));
    if (running === undefined || !namesNewer(recorded, running)) {
        return [];
    }
    const from = recorded.kind === 'version' ? recorded.text : 'a newer format';
    return [
        {
            line: `SET ${path}: ${from} -> ${version}, so the next start of a newer teamrig refreshes what this writes`,
            act: () => files.write(path, formatRecord(version, now)),
        },
    ];
}
/** The record's text: its format, the version that refreshed and when. */
function formatRecord(version, at) {
    return `${JSON.stringify({ [VERSION_FIELD]: LAUNCHER_RECORD_FORMAT, version, at: new Date(at).toISOString() }, null, 2)}\n`;
}
const CURRENT = { kind: 'current' };
/** Refreshes the launchers when this version is newer than the record's, the record read once outside the lock. */
export async function refreshLaunchers(refresh) {
    const { machine, lock } = refresh;
    const running = parseVersion(refresh.version);
    const path = launcherRecordPath(machine.kitHome);
    if (running === undefined || !isDue(recordedOf(await machine.files.read(path)), running)) {
        return CURRENT;
    }
    try {
        return await lock.run(async () => {
            const recorded = recordedOf(await machine.files.read(path));
            return isDue(recorded, running) ? await refreshUnderLock(refresh, recorded) : CURRENT;
        });
    }
    catch (error) {
        if (error instanceof LockBusyError) {
            return { kind: 'busy' };
        }
        throw error;
    }
}
/** Reads what is out of date and takes each step in order, logging each; writes the record once all are done. */
async function refreshUnderLock(refresh, recorded) {
    const { machine, others, version, now } = refresh;
    const { files, kitHome } = machine;
    const from = recorded.kind === 'version' ? recorded.text : 'none';
    const log = async (line) => {
        await files.append(restoreLogPath(kitHome), `${new Date(now).toISOString()} launchers: ${from} -> ${version}: ${line}\n`);
    };
    const failed = async (what, error) => {
        const line = `FAILED ${what}: ${errorMessage(error)}; the next session start tries again`;
        await log(line);
        return { kind: 'failed', line };
    };
    let steps;
    try {
        const otherSteps = await Promise.all(others.map((launcher) => launcherStep(files, launcher, 'refresh')));
        steps = [...otherSteps.flat(), ...(await restorePlan(machine, 'refresh')).steps];
    }
    catch (error) {
        return failed('reading what is out of date', error);
    }
    for (const step of steps) {
        try {
            await step.act();
        }
        catch (error) {
            return failed(step.line, error);
        }
        await log(step.line);
    }
    await files.write(launcherRecordPath(kitHome), formatRecord(version, now));
    return { kind: 'refreshed', steps: steps.map((step) => step.line) };
}
