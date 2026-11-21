import { parseJsonl } from "../core/jsonl.js";
import { isCappedCommand } from "../permissions/service-commands.js";
import { heldBack } from "./permission.js";
/** The rolling window the daily cap counts over. */
export const ROLE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * How many calls the role's allow let run at or after `sinceMs` toward its cap, by the prompt-answers log's text: one
 * for each close, and for a migrate its `count`, the issue rows its file held (T4606), so a run opening fifty issues
 * weighs fifty; a ship counts toward no cap. A line with no positive whole `count` weighs one.
 */
export function roleAllowsSince(log, role, sinceMs) {
    return parseJsonl(log)
        .records.filter(({ record }) => {
        const at = record['at'];
        return record['answer'] === 'role' && record['role'] === role && isCappedCommand(record['command']) && typeof at === 'string' && Date.parse(at) >= sinceMs;
    })
        .reduce((sum, { record }) => sum + weightOf(record['count']), 0);
}
function weightOf(count) {
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 1;
}
/**
 * One line of the team's prompt-answers log for a role's allow, beside the route allows: the role, the table command and
 * the issue or branch it acts on, never the comment's text (C7).
 */
export function roleAllowRecord(facts) {
    return {
        v: 1,
        at: facts.at.toISOString(),
        session: facts.session,
        claudeSession: facts.claudeSession,
        tool: 'Bash',
        event: 'PreToolUse',
        answer: 'role',
        role: facts.role,
        command: facts.call.command,
        target: facts.call.target,
        ...(facts.count === undefined ? {} : { count: facts.count }),
    };
}
/** The hook's reply to a role's call: an allow naming the role, the command and the issue or branch. */
export function roleAllowReply(role, call) {
    return { verdict: { kind: 'allow', reason: `teamrig: the service role ${role} lets this session run ${call.command} on ${call.target}` } };
}
/**
 * The hook's reply once the role has no room left in 24 hours for a call weighing `weight` (a migrate's issue rows): a
 * refusal, saying when the role runs again, and for a migrate that a file past the whole cap must be split.
 */
export function roleCapReply(role, cap, weight = 1) {
    const ran = weight > 1 ? `has less room than this run's ${weight} issue rows left of its ${cap} calls` : `ran its ${cap} calls`;
    const split = weight > cap ? ' A rows file holding more issue rows than the cap never runs under the role: split it.' : '';
    return heldBack('ask', `teamrig: the service role ${role} ${ran} of the last 24 hours (prompts.serviceRoleDailyCap), so this one is refused. ` +
        `The role runs again once its oldest call of the window is 24 hours old; only the owner raises the cap.${split}`);
}
