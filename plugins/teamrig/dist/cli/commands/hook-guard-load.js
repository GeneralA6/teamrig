import { resolveTeam } from "../../core/team.js";
import { openKit, teamFolders } from "../kit.js";
/**
 * The team of the folder a hook's call runs in. `folder` is the one the hook event names, undefined when the input
 * named none; it comes first, since the host may start the hook process somewhere else.
 */
export function hookTeam(folder, runtime) {
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [folder, runtime.cwd]));
}
/**
 * The config a guard hook reads for a call in `folder` (see `hookTeam`), or undefined outside a team's projects, where
 * the guard prints nothing. A broken pointer, or a config that cannot even be opened, gives no load, so the guard keeps
 * its defaults: neither turns it off.
 */
export async function guardLoadOf(folder, runtime) {
    const found = await hookTeam(folder, runtime);
    if (found.kind === 'none') {
        return undefined;
    }
    const kit = found.kind === 'team' ? await openKit(runtime, found.team).catch(() => undefined) : undefined;
    return { kit, load: kit?.load };
}
