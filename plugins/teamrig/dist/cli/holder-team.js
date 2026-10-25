import { formatAddress } from "../core/address.js";
import { SecretScanner } from "../core/secrets.js";
import { postLine } from "../inbox/inbox.js";
import { inboxDepsOf } from "./commands/inbox.js";
import { openKit } from "./kit.js";
/**
 * The team of a role's holder (roleHolderOf): the posting team itself, or a team above it that a child team leaves
 * the role to (T1143); a team above with no config to read gives the problem instead, for the poster to warn about.
 */
async function holderTeamOf(runtime, own, holder) {
    const team = own.kit.paths.team;
    const sender = (id) => sessionNameOn(holder.team, team, id);
    if (holder.team === team) {
        return { ok: true, holder: { kit: own.kit, config: own.config, sender } };
    }
    const kit = await openKit(runtime, holder.team);
    if (kit.load.status !== 'loaded') {
        return { ok: false, problem: `no team ${holder.team} with a config in this kit home` };
    }
    return { ok: true, holder: { kit, config: kit.load.config, sender } };
}
/** How team `reader` names session `id` of team `team`: its bare id at home, `<team>/<id>` on another team. */
export function sessionNameOn(reader, team, id) {
    return reader === team ? id : formatAddress({ team, id });
}
/** Posts a line to a team's inbox; why the inbox refused it (a secret pattern, not one line), else undefined. */
export function postInboxLine(runtime, kit, config, line) {
    return postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), { ...line, now: new Date(runtime.clock.now()) });
}
/**
 * Posts a line to a role's holder on whichever team it sits (holderTeamOf), its sender named as that team names the
 * posting team's sessions, through `post`; why it was not posted, a holder team with no config included, else undefined.
 */
export async function postToHolder(runtime, own, holder, line, post = postInboxLine) {
    const found = await holderTeamOf(runtime, own, holder);
    if (!found.ok) {
        return found.problem;
    }
    return post(runtime, found.holder.kit, found.holder.config, { to: holder.id, from: found.holder.sender(line.from), text: line.text });
}
