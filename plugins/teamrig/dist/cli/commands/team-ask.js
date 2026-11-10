import { formatAddress } from "../../core/address.js";
import { askedNotice } from "../../register/views.js";
import { openKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { teamOf, tellAssigned, tellLine } from "./register-team.js";
/** The caller, a session of team `team`, as `<team>/<id>` and the team tree it writes across; refused when team `target` has no config here. */
export async function treeCallerOf(runtime, team, caller, target) {
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const from = { team, id: sessionIdOf(await rosterOf(runtime, kit, config), caller) };
    const { tree } = await loadTree(runtime);
    const targetLead = tree.leadOf(target);
    if (targetLead === undefined) {
        throw new RefusedError(`no team ${target} with a config in this kit home`);
    }
    return { from, config, tree, targetLead };
}
/**
 * Whether the caller may relay an owner's order into team `asked`: it leads a team above that one. The owner's orders
 * come down the tree through its leads (core rule 1), so a lead below, a sibling team's lead or a lead's own session
 * asks as itself.
 */
export function relaysTo(caller, asked) {
    const { from, tree } = caller;
    return tree.leadOf(from.team) === from.id && tree.ancestorsOf(asked).includes(from.team);
}
/**
 * A session asks another team of its tree for work (T1141). The task lands in that team's register only, as an event
 * by the asker's `<team>/<id>`, which is also its source, owned by `ask.owner`, else by that team's lead. The owner
 * gets an inbox line from the asker's address, and the team's lead, when it is not the owner, a copy line, as it sets
 * its team's work order and may reorder or reassign it. A relayed owner's order (`ask.ownerRelay`) is sourced as that
 * team's register.ownerSource instead, its event still by the asker. A team outside the caller's tree, an owner not
 * on its roster, or a relay from a session that does not lead a team above it, is refused; a refused write tells no one.
 */
export async function askTeam(runtime, caller, ask, input) {
    const { asked } = ask;
    const from = formatAddress(caller.from);
    if (!caller.tree.sameTree(caller.from.team, asked)) {
        throw new RefusedError(`team ${asked} is not in ${caller.from.team}'s team tree, so ${from} may not add its tasks`);
    }
    const relay = ask.ownerRelay === true;
    if (relay && !relaysTo(caller, asked)) {
        const { ownerSource } = caller.config.register;
        throw new RefusedError(`${from} may not relay ${ownerSource}'s order into team ${asked}: only the lead of a team above it does; ask without --source ${ownerSource}, or ask your lead to relay it`);
    }
    const target = await teamOf(runtime, await openKit(runtime, asked), 'write');
    const lead = caller.targetLead;
    const found = ask.owner === undefined ? { ok: true, id: lead } : target.roster.lookup(ask.owner);
    if (!found.ok) {
        throw new RefusedError(`team ${asked}: ${found.error}`);
    }
    const owned = { ...input, owner: found.id };
    const verdict = relay
        ? await target.register.relayFromTeam(from, { ...owned, source: target.config.register.ownerSource })
        : await target.register.addFromTeam(from, { ...owned, source: from });
    if (verdict.ok) {
        const { task } = verdict.value;
        await tellAssigned(runtime, target, from, task, formatAddress({ team: asked, id: task.owner }));
        if (task.owner !== lead) {
            const shown = formatAddress({ team: asked, id: lead });
            await tellLine(runtime, target, from, lead, askedNotice(task, target.zone), `${shown} was not told of ${task.id}`, shown);
        }
    }
    return { verdict, target };
}
