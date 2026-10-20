import { MeetingStore } from "../meeting/state.js";
import { TaskTree } from "../register/tree.js";
import { decisionBatch } from "./batch.js";
import { askedAtOf, AskedStore } from "./store.js";
/**
 * A team's batch of the owner's decisions now: its register's waits on the owner against the batches the lead asked,
 * their effective dues on the team's clock (`zone`).
 */
export async function teamDecisions(files, paths, config, tasks, now, zone) {
    const [asked, meeting] = await Promise.all([new AskedStore(files, paths.decisionsAsked).read(), new MeetingStore(files, paths.meeting).read()]);
    const tree = new TaskTree(tasks, new Date(now), zone);
    const batch = decisionBatch({
        tasks: tasks.values(),
        tree,
        now,
        askedAt: askedAtOf(asked, meeting),
        ownerMarker: config.register.ownerSource,
        config: config.decisions,
    });
    return { batch, tree };
}
