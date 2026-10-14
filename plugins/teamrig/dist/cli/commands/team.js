import { isRole } from "../../config/roster.js";
import { UsageError } from "../args.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
/** One roster line: `<id> <name>`, then the roles the session holds. */
function rosterLine(roster, id) {
    const roles = roster.rolesOf(id);
    return `${id} ${roster.nameOf(id) ?? id}${roles.length === 0 ? '' : ` (${roles.join(', ')})`}`;
}
/** A session by id or name, else the holder of a role, so `who lead` works whatever the lead's id. */
function idOf(roster, text) {
    const found = roster.lookup(text);
    if (found.ok || !isRole(text)) {
        return sessionIdOf(roster, text);
    }
    const holder = roster.holderOf(text);
    if (holder === undefined) {
        throw new RefusedError(`no session holds the ${text} role`);
    }
    return holder;
}
/** `who [<id|name|role>]`: the name to message a session by; with no argument, every session. */
export async function who(args, runtime) {
    const [text, extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const kit = await openTeamKit(runtime);
    const roster = rosterOf(kit, requireConfig(kit, runtime, 'read'));
    if (text === undefined) {
        roster.ids.forEach((id) => runtime.out.stdout(rosterLine(roster, id)));
        return EXIT.ok;
    }
    const id = idOf(roster, text);
    runtime.out.stdout(roster.nameOf(id) ?? id);
    return EXIT.ok;
}
