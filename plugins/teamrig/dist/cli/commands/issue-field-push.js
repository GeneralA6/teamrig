import { fieldWriteLine, planFieldPush } from "../../issues/field-push.js";
import { targetText } from "../../issues/host.js";
import { teamZone } from "../kit.js";
import { teamRanking } from "../team-ranking.js";
import { taskTreeOf } from "./register.js";
/** The field writes a repository prints; the rest are counted. */
export const SHOWN_FIELD_WRITES = 10;
/**
 * The field run of a team's push, or undefined when `github.fields.push` is off. The scores are the ranking's at this
 * read, as `teamrig list` shows them; a push run is short, so a score that moves during it is written on the next.
 */
export async function fieldRunOf(runtime, config, paths, register) {
    if (!config.github.fields.push) {
        return undefined;
    }
    const [snapshot, elsewhere] = await Promise.all([register.snapshot(), register.elsewhere()]);
    const ranking = await teamRanking(runtime, paths, config, snapshot.state.tasks.values());
    const tree = taskTreeOf({ snapshot, config, elsewhere, ranking }, runtime);
    return { config: config.github.fields, zone: teamZone(config, runtime), scoreOf: (task) => tree.rankedOf(task)?.score };
}
const NOTHING = { planned: 0, writes: 0, sent: 0, failed: undefined };
/**
 * Plans the fields and types of one repository's issues (issues/field-push.ts) and, with send, writes them one by
 * one, stopping at the first failure so the rest is planned again on the next run. A host with no fields capability,
 * or a repository with no fields or types, writes none, prints nothing and is no failure; a failed fields read is one.
 */
export async function pushFields(step, say) {
    const { host, repo } = step;
    const fields = host.fields;
    if (fields === undefined) {
        return NOTHING;
    }
    const read = await fields.read(repo);
    // Quiet: a repository with no fields or types is most repositories, and the push has nothing to say of it each run.
    if (read.kind === 'none') {
        return NOTHING;
    }
    if (read.kind === 'failed') {
        say(`FAILED ${repo}: ${read.reason}; no field or type planned for it`);
        return { ...NOTHING, failed: read.reason };
    }
    read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
    const labels = new Map(step.issues.map((issue) => [issue.number, issue.labels]));
    const plan = planFieldPush({
        repo,
        read,
        tasks: step.tasks,
        labelsOf: (number) => labels.get(number) ?? [],
        config: step.run.config,
        zone: step.run.zone,
        scoreOf: step.run.scoreOf,
        writes: step.writes,
    });
    fieldPlanLines(repo, plan).forEach(say);
    const planned = plan.writes.length;
    if (!step.send) {
        return { ...NOTHING, planned, writes: planned };
    }
    const changed = new Set();
    let written = 0;
    for (const write of plan.writes) {
        const end = write.kind === 'type' ? await fields.setType(write.target, write.type) : await fields.setField(write.target, write.field, write.value);
        if (end.kind === 'failed') {
            say(`FAILED ${targetText(write.target)} ${write.task}: ${end.reason}; the rest of the fields of ${repo} wait for the next run`);
            return { planned, writes: written, sent: changed.size, failed: end.reason };
        }
        written += 1;
        changed.add(write.target.number);
        say(`SENT ${fieldWriteLine(write)}`);
    }
    return { planned, writes: written, sent: changed.size, failed: undefined };
}
/** A repository's field plan: its counts, the writes this run sends, and what it skipped. */
export function fieldPlanLines(repo, plan) {
    const counts = [`${plan.writes.length} to write`, ...(plan.deferred === 0 ? [] : [`${plan.deferred} left for the next run`])];
    const writes = plan.writes.map(fieldWriteLine);
    const more = writes.length - SHOWN_FIELD_WRITES;
    return [
        `FIELDS ${repo}: ${counts.join(', ')}`,
        ...(more > 0 ? [...writes.slice(0, SHOWN_FIELD_WRITES), `... and ${more} more`] : writes),
        ...plan.notes.map((note) => `NOTE ${repo}: ${note}`),
    ];
}
