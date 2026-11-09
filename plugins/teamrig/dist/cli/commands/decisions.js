import { formatAddress } from "../../core/address.js";
import { KIT_NAME } from "../../core/home.js";
import { nextBatchText, waitsOfTeams } from "../../decisions/batch.js";
import { batchLines } from "../../decisions/lines.js";
import { AskedStore } from "../../decisions/store.js";
import { taskLabel } from "../../register/views.js";
import { noPositionals } from "../args.js";
import { readRunFiles } from "../hand-step-file.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { ownerBatchOf } from "../owner-batch.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { ownRegister } from "./register.js";
/** The caller's team and the batch that holds its waits now: in a child team, only its own and its teams' waits of it. */
async function decisionsKit(args, runtime, access) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, access);
    const roster = await rosterOf(runtime, kit, config);
    const lead = config.roles.lead;
    const { snapshot, elsewhere, ranking } = (await ownRegister(runtime)).own;
    const now = runtime.clock.now();
    const zone = teamZone(config, runtime);
    const team = kit.paths.team;
    const loaded = await loadTree(runtime);
    const { batch, askedBy } = await ownerBatchOf(runtime, { team, config, paths: kit.paths, tasks: snapshot.state.tasks, elsewhere, ranking }, loaded, now);
    const held = askedBy === undefined ? batch : waitsOfTeams(batch, [team, ...loaded.tree.descendantsOf(team)]);
    return { kit, config, roster, lead, now, zone, batch: held, askedBy };
}
/** `decisions`: the batch the lead asks the owner next, and whether it is due now. */
export async function decisions(args, runtime) {
    const dk = await decisionsKit(args, runtime, 'read');
    const askedBy = dk.askedBy === undefined ? undefined : formatAddress(dk.askedBy);
    const runFiles = await readRunFiles(runtime, [...dk.batch.pending, ...dk.batch.overdue].map((wait) => wait.task));
    const lines = batchLines({ batch: dk.batch, ownerMarker: dk.config.register.ownerSource, command: KIT_NAME, lead: dk.lead, askedBy, zone: dk.zone, runFiles });
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
    if (dk.askedBy !== undefined) {
        const team = dk.kit.paths.team;
        throw new RefusedError(`team ${team} asks no owner: ${formatAddress(dk.askedBy)} asks the owner ${team}'s waits, in its batches`);
    }
    const ids = [...dk.batch.pending, ...dk.batch.overdue].map((wait) => taskLabel(wait.task, wait.team));
    if (ids.length === 0) {
        runtime.out.stdout(`ASKED nothing: no wait on ${dk.config.register.ownerSource} to ask; nothing recorded`);
        return EXIT.ok;
    }
    await new AskedStore(runtime.files, dk.kit.paths.decisionsAsked).write({ askedAt: new Date(dk.now).toISOString(), by: dk.lead, ids });
    runtime.out.stdout(`ASKED ${ids.length} decision(s) ${dk.zone.weekdayMinute(new Date(dk.now))}: ${ids.join(', ')}; ${nextBatchText(dk.batch, dk.zone)} holds the waits set since and the ones past due`);
    return EXIT.ok;
}
