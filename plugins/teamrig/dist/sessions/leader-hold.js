import { answerTo } from "../register/approval.js";
import { ACTIVE_STATUSES } from "../register/model.js";
/**
 * Whether the idle pass never closes a team's lead for being quiet (T3387): by `open.idle.leaders`, `all` keeps
 * every team's lead, `root` the lead of a team with no parent alone, the root of its tree (a config with no `team`
 * predates trees and is a root). A child team's lead then closes like any session, but for what keeps a leader
 * ({@link leaderHoldOf}), and reopens on the same triggers.
 */
export function leadNeverCloses(idle, team) {
    return idle.leaders === 'all' || team?.parent === undefined;
}
/**
 * The first thing that keeps a quiet leader open, else undefined: a live task's approval or decision wait naming it
 * (or the owner, for the lead) that is not answered yet, an approval its giver answered or a decision a leader
 * recorded counting as answered; then a session it leads that runs, since a member's ask lands on its leader. Work
 * the leader can start, an urgent line and an open meeting it is in keep it as they keep any session.
 */
export function leaderHoldOf(input) {
    const names = new Set([input.leader, ...(input.ownerMarker === undefined ? [] : [input.ownerMarker])]);
    for (const task of input.tasks.values()) {
        if (!ACTIVE_STATUSES.includes(task.status)) {
            continue;
        }
        const reason = task.waits.find((wait) => (wait.kind === 'approval' || wait.kind === 'decision') && names.has(wait.who) && !isAnswered(task, wait));
        if (reason !== undefined) {
            return { kind: 'waits', task, reason };
        }
    }
    const session = input.led.find((id) => id !== input.leader && input.running.has(id));
    return session === undefined ? undefined : { kind: 'leads', session };
}
function isAnswered(task, wait) {
    return wait.kind === 'approval' ? answerTo(task, wait) !== undefined : task.decided !== null;
}
