import { isRecord, stringField } from "../../core/guards.js";
import { resolveTeam } from "../../core/team.js";
import { openKit, teamFolders } from "../kit.js";
/** The payload's folder first: Claude Code may start the hook process somewhere else. */
export function hookTeam(payload, runtime) {
    const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd, runtime.cwd]));
}
/**
 * The config a guard hook reads, or undefined outside a team's projects, where the guard prints nothing. A broken
 * pointer, or a config that cannot even be opened, gives no load, so the guard keeps its defaults: neither turns it off.
 */
export async function guardLoadOf(payload, runtime) {
    const found = await hookTeam(payload, runtime);
    if (found.kind === 'none') {
        return undefined;
    }
    const kit = found.kind === 'team' ? await openKit(runtime, found.team).catch(() => undefined) : undefined;
    return { kit, load: kit?.load };
}
