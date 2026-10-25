import { KIT_NAME } from "../../core/home.js";
import { nextBatchText } from "../../decisions/batch.js";
import { batchLines } from "../../decisions/lines.js";
import { AskedStore } from "../../decisions/store.js";
import { teamDecisions } from "../../decisions/team.js";
import { noPositionals } from "../args.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { ownRegister } from "./register.js";
/** The caller's team and its batch now, judged on the team's own register. */
async function decisionsKit(args, runtime, access) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, access);
    const roster = await rosterOf(runtime, kit, config);
    const lead = config.roles.lead;
    const { snapshot, elsewhere } = (await ownRegister(runtime)).own;
    const tasks = snapshot.state.tasks;
    const now = runtime.clock.now();
    const zone = teamZone(config, runtime);
    const decided = await teamDecisions(runtime.files, kit.paths, config, tasks, now, zone, elsewhere);
    return { kit, config, roster, lead, tasks, now, zone, ...decided };
}
/** `decisions`: the batch the lead asks the owner next, and whether it is due now. */
export async function decisions(args, runtime) {
    const dk = await decisionsKit(args, runtime, 'read');
    const lines = batchLines({ batch: dk.batch, tree: dk.tree, byId: dk.tasks, ownerMarker: dk.config.register.ownerSource, command: KIT_NAME, lead: dk.lead, zone: dk.zone });
    lines.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/** `decisions asked`: the lead records that it asked the owner the batch, the waits not yet asked and the ones past due. */
export async function decisionsAsked(args, runtime) {
    const dk = await decisionsKit(args, runtime, 'write');
    const caller = sessionIdOf(dk.roster, callerOf(args.flags, runtime.env));
    if (caller !== dk.lead) {
        throw new RefusedError(`only the lead (${dk.roster.nameOf(dk.lead) ?? dk.lead}) asks the owner's decisions`);
    }
    const ids = [...dk.batch.pending, ...dk.batch.overdue].map((task) => task.id);
    if (ids.length === 0) {
        runtime.out.stdout(`ASKED nothing: no wait on ${dk.config.register.ownerSource} to ask; nothing recorded`);
        return EXIT.ok;
    }
    await new AskedStore(runtime.files, dk.kit.paths.decisionsAsked).write({ askedAt: new Date(dk.now).toISOString(), by: dk.lead, ids });
    runtime.out.stdout(`ASKED ${ids.length} decision(s) ${dk.zone.weekdayMinute(new Date(dk.now))}: ${ids.join(', ')}; ${nextBatchText(dk.batch, dk.zone)} holds the waits set since and the ones past due`);
    return EXIT.ok;
}
