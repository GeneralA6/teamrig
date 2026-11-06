import { MeetingStore } from "../meeting/state.js";
import { TaskTree } from "../register/tree.js";
import { decisionBatch } from "./batch.js";
import { askedAtOf, AskedStore } from "./store.js";
/**
 * A team's batch of the owner's decisions now: the waits on the owner of its own register and of the registers under
 * it, each with its effective dues on its own team's clock, judged with the tasks the tree's other registers hold,
 * against the batches the team's lead asked.
 */
export async function teamDecisions(files, paths, config, registers, now) {
    const [asked, meeting] = await Promise.all([new AskedStore(files, paths.decisionsAsked).read(), new MeetingStore(files, paths.meeting).read()]);
    return decisionBatch({ registers: registers.map((register) => batchRegisterOf(register, now)), now, askedAt: askedAtOf(asked, meeting), config: config.decisions });
}
function batchRegisterOf({ team, tasks, ownerMarker, requireGate, zone, elsewhere, ranking }, now) {
    return { team, tasks: tasks.values(), tree: new TaskTree(tasks, new Date(now), zone, undefined, elsewhere, ranking), ownerMarker, requireGate };
}
