import { formatUtcDay } from "../core/time.js";
import { ISSUE_LIMIT, listIssues } from "./issues.js";
import { latestIssues } from "./plan.js";
const DAY_MS = 86_400_000;
/** The first day whose closed issues a sync reads: `closedDays` before now, UTC. */
export function closedSince(now, closedDays) {
    return formatUtcDay(new Date(now.getTime() - closedDays * DAY_MS));
}
/**
 * Reads a repository's open issues, then those closed on or after `since`: pages of the two shipped issue queries
 * and nothing else. When either fails the repository is left out whole, so its tasks are not judged on half a read.
 */
export async function readRepo(gh, access, repo, since) {
    const open = await listIssues(gh, access, { repo, state: 'open', limit: ISSUE_LIMIT });
    if (open.kind === 'failed') {
        return { kind: 'failed', repo, reason: open.reason };
    }
    const closed = await listIssues(gh, access, { repo, state: 'closed', closedSince: since, limit: ISSUE_LIMIT });
    if (closed.kind === 'failed') {
        return { kind: 'failed', repo, reason: closed.reason };
    }
    return { kind: 'read', repo, issues: latestIssues(open.issues, closed.issues), notes: [...listNotes('open', open), ...listNotes('closed', closed)] };
}
/** What a reader of the sync should know about one list: it may be cut short, or gh printed items it could not read. */
function listNotes(state, list) {
    return [
        ...(list.full ? [`the ${state} list reached ${ISSUE_LIMIT} issues, so it may leave some out`] : []),
        ...(list.unreadable > 0 ? [`${list.unreadable} ${state} item(s) gh printed did not read as issues and were left out`] : []),
    ];
}
/** Writes the steps in order, each judged again under the register's lock; a refused step is reported and the rest still run. */
export async function applySteps(writer, steps) {
    const outcomes = [];
    for (const step of steps) {
        const verdict = await writeStep(writer, step);
        outcomes.push({ step, result: verdict.ok ? { ok: true, value: verdict.value.task.id } : verdict });
    }
    return outcomes;
}
function writeStep(writer, step) {
    switch (step.kind) {
        case 'add':
            return writer.importAdd(step.input);
        case 'update':
            return writer.importUpdate(step.id, step.changes, step.note);
        case 'status':
            return writer.importStatus(step.id, step.input);
    }
}
