/** The exit code a review check flags a change with; what it prints is the findings. */
export const REVIEW_CHECK_FLAGGED = 3;
/** How long a security hold waits on the security reviewer alone before the session's nearest leader may answer it. */
export const REVIEW_FALLBACK_MS = 30 * 60_000;
/** Whether the change needs the review check: it hit a `check` entry, and no `always` security entry holds it anyway. */
export function needsCheck(hits) {
    return hits.some((hit) => hit.entry.mode === 'check') && !hits.some((hit) => hit.entry.mode === 'always' && hit.entry.class === 'security');
}
/**
 * The class a change waits on, undefined when it is clear: an `always` hit waits on its entry's class, and so does a
 * `check` hit unless the check came back clean. A check that broke or never ran is no pass, so its hit waits as a
 * flagged one, on the reviewer who keeps the check. A change with hits of both classes waits on security, the stricter
 * reviewer, whose hold a leader may still answer after `REVIEW_FALLBACK_MS`.
 */
export function holdClassOf(hits, check) {
    const classes = new Set();
    for (const { entry } of hits) {
        if (entry.mode === 'always' || check?.kind !== 'clean') {
            classes.add(entry.class);
        }
    }
    return classes.has('security') ? 'security' : classes.has('leader') ? 'leader' : undefined;
}
/**
 * The reviewer of the session's held change, never the session itself (self-review is refused): a security hold goes
 * to `roles.securityReviewer` with the session's nearest leader as its fallback, a leader hold to that nearest leader;
 * each goes to the other when its own is missing or is the session, so the lead's own change goes to security.
 */
export function reviewRoute(holdClass, session, tree, roles) {
    const leader = tree.approversOf(session).find((who) => who !== session);
    const reviewer = roles.securityReviewer === session ? undefined : roles.securityReviewer;
    const [first, second] = holdClass === 'security' ? [reviewer, leader] : [leader, reviewer];
    if (first !== undefined) {
        return { kind: 'route', who: first, fallback: holdClass === 'security' ? second : undefined };
    }
    if (second !== undefined) {
        return { kind: 'route', who: second, fallback: undefined };
    }
    return { kind: 'none', reason: `no one but ${session} could review its change: set roles.securityReviewer to another session` };
}
/** Whether a leader may answer the hold yet: a security hold, once `REVIEW_FALLBACK_MS` passed since it was made. */
export function fallbackOpen(route, createdAt, now) {
    return route.fallback !== undefined && now >= createdAt + REVIEW_FALLBACK_MS;
}
/**
 * Whether the task's answer approves the hold: approved after the hold was made, by its reviewer, or by its fallback
 * leader once the fallback time had passed. An answer from before the hold approved an earlier change.
 */
export function holdApproved(route, createdAt, answer) {
    if (answer?.verdict !== 'approved') {
        return false;
    }
    const at = Date.parse(answer.at);
    if (!(at > createdAt)) {
        return false;
    }
    return answer.by === route.who || (answer.by === route.fallback && fallbackOpen(route, createdAt, at));
}
