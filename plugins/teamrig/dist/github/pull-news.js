import { cut } from "../register/views.js";
import { branchTaskOf } from "../worktree/owner.js";
import { issueRef } from "./map.js";
import { isOurAuthor } from "./trust.js";
/** What a pull request that just opened is compared with, so one opened already conflicting or failing says so. */
const FRESH = { mergeable: 'mergeable', checks: 'none', review: 'none' };
/**
 * What happened between the last read (`before`) and this one: `open`, every open pull request, and `changed`, those
 * in any state changed since the last read's cursor, each newest change first (host.ts).
 *
 * With no `before` (the first read of a repository) nothing is news: it only marks, so the history is never replayed.
 * An open one with no mark opened since the cursor, unless it was opened before it (reopened, or past an open read
 * cut at its limit): that one is marked silently. A conflict, failing checks or a review state is news when it
 * starts, never again while it lasts; GitHub's `unknown` mergeable (not worked out yet) keeps the last known value. A
 * merged or closed one is news when it was marked open, or ended after the cursor. A mark of one neither open nor
 * ended in this read is dropped, as an open read cut at its limit leaves it out; it marks again silently when read.
 */
export function pullEvents(before, open, changed) {
    const marks = new Map((before?.open ?? []).map((mark) => [mark.number, mark]));
    const ended = new Map();
    for (const pull of changed) {
        if (pull.state !== 'open' && !ended.has(pull.number)) {
            ended.set(pull.number, pull);
        }
    }
    const events = [];
    const after = [];
    for (const pull of open) {
        if (ended.has(pull.number)) {
            continue;
        }
        const mark = marks.get(pull.number);
        const fresh = mark === undefined && before !== undefined && isAfter(pull.createdAt, before.cursor);
        if (fresh) {
            events.push({ kind: 'opened', pull });
        }
        const last = mark ?? (fresh ? { number: pull.number, ...FRESH } : undefined);
        const now = { number: pull.number, mergeable: pull.mergeable === 'unknown' ? (last?.mergeable ?? 'unknown') : pull.mergeable, checks: pull.checks, review: pull.review };
        if (last !== undefined) {
            events.push(...changes(last, now).map((kind) => ({ kind, pull })));
        }
        after.push(now);
    }
    if (before !== undefined) {
        for (const pull of ended.values()) {
            if (marks.has(pull.number) || isAfter(pull.mergedAt ?? pull.closedAt ?? pull.updatedAt, before.cursor)) {
                events.push({ kind: pull.state === 'merged' ? 'merged' : 'closed', pull });
            }
        }
    }
    return { events, after: { cursor: newest([...open, ...changed].map((pull) => pull.updatedAt), before?.cursor), open: after } };
}
/** The events a mark's change makes: each state that starts with it. */
function changes(last, now) {
    return [
        ...(now.mergeable === 'conflicting' && last.mergeable !== 'conflicting' ? ['conflict'] : []),
        ...(now.checks === 'failing' && last.checks !== 'failing' ? ['checks-failing'] : []),
        ...(now.review !== last.review && now.review === 'approved' ? ['approved'] : []),
        ...(now.review !== last.review && now.review === 'changes-requested' ? ['changes-requested'] : []),
    ];
}
/** Whether `time` is after `cursor`; every time is after no cursor (a repository that had no pull request yet). */
function isAfter(time, cursor) {
    return cursor === undefined || Date.parse(time) > Date.parse(cursor);
}
/** The newest of `times` and `cursor`, or undefined when there is none. */
function newest(times, cursor) {
    return [...times, ...(cursor === undefined ? [] : [cursor])].reduce((best, time) => (best === undefined || Date.parse(time) > Date.parse(best) ? time : best), undefined);
}
/**
 * Who hears about `pull`: the owner of the task its branch names (`t<id>-...`, worktree/owner.ts), when it is a
 * branch of the repository itself by one of the team's own authors (`isOurAuthor`), else `watcher`. A fork's
 * branch name, or anyone else's, is theirs to choose, so it never routes news to a session.
 */
export function pullRecipient(pull, ours, ownerOf, watcher) {
    const task = ownBranchTask(pull, ours);
    return (task === undefined ? undefined : ownerOf(task)) ?? watcher;
}
/** The task one of our authors' own branch of the repository names (`t<id>-...`); undefined for a fork, anyone else or another branch name. */
export function ownBranchTask(pull, ours) {
    return pull.fork || !isOurAuthor(pull.authorAssociation, pull.author, ours) ? undefined : branchTaskOf(pull.head);
}
/** The events of each recipient, in the order first seen (`pullRecipient`). */
export function eventsByRecipient(events, recipientOf) {
    const byRecipient = new Map();
    for (const event of events) {
        const to = recipientOf(event.pull);
        byRecipient.set(to, [...(byRecipient.get(to) ?? []), event]);
    }
    return byRecipient;
}
/** The pull requests one inbox line names; the rest are counted. */
const NAMED_PULLS = 8;
/** How much of a pull request title an inbox line repeats. */
const TITLE_CHARS = 60;
/** How much of a CI job or step name an inbox line repeats. */
const JOB_CHARS = 40;
/** How each event reads in a line. */
const EVENT_WORDS = {
    opened: 'opened',
    merged: 'merged',
    closed: 'closed unmerged',
    conflict: 'conflicts with its base',
    'checks-failing': 'checks failing',
    approved: 'approved',
    'changes-requested': 'changes requested',
};
/**
 * The inbox line for `events`, one entry per pull request in the order first seen, at most NAMED_PULLS named and
 * the rest counted. A title is outside input: quoted, as data, and cut short. Failing checks with an excerpt name
 * each failed job and step, quoted and cut the same way, and the file holding its log's end. It wakes the session only for what
 * needs its hand now (T3021 section 3): an outsider's new pull request, and a conflict or failing checks on a
 * session's own pull request (one of our authors' branch that names a task, `ownBranchTask`). The rest (a merge, a
 * close, a review, an outsider's conflict or red checks, which are the outsider's to fix) waits for the session's
 * next turn. Anyone not one of `ours` counts as an outsider, a collaborator too.
 */
export function pullNewsText(events, ours) {
    const byPull = new Map();
    for (const event of events) {
        const key = issueRef(event.pull.repo, event.pull.number);
        const entry = byPull.get(key) ?? { pull: event.pull, events: [] };
        entry.events.push(event);
        byPull.set(key, entry);
    }
    const entries = [...byPull].map(([ref, { pull, events: own }]) => `${ref} ${JSON.stringify(cut(pull.title, TITLE_CHARS))}: ${own.map((event) => eventWords(event, ours)).join(', ')}`);
    const more = entries.length - NAMED_PULLS;
    return {
        text: `GitHub pull requests: ${entries.slice(0, NAMED_PULLS).join('; ')}${more > 0 ? `; and ${more} more` : ''}`,
        wake: events.some(({ kind, pull }) => wakes(kind, pull, ours)),
    };
}
/** Whether `kind` on `pull` wakes its recipient (pullNewsText). */
function wakes(kind, pull, ours) {
    switch (kind) {
        case 'opened':
            return !isOurAuthor(pull.authorAssociation, pull.author, ours);
        case 'conflict':
        case 'checks-failing':
            return ownBranchTask(pull, ours) !== undefined;
        case 'merged':
        case 'closed':
        case 'approved':
        case 'changes-requested':
            return false;
    }
}
function eventWords({ kind, pull, ci }, ours) {
    if (kind === 'checks-failing' && ci !== undefined) {
        const jobs = ci.jobs.map(({ name, step }) => `${JSON.stringify(cut(name, JOB_CHARS))}${step === undefined ? '' : ` at ${JSON.stringify(cut(step, JOB_CHARS))}`}`);
        return `${EVENT_WORDS[kind]} (${jobs.join(', ')}; log end in ${ci.file})`;
    }
    if (kind !== 'opened') {
        return EVENT_WORDS[kind];
    }
    const by = pull.author === '' ? 'a deleted account' : pull.author;
    const where = [...(isOurAuthor(pull.authorAssociation, pull.author, ours) ? [] : ['outside']), ...(pull.fork ? ['fork'] : []), ...(pull.draft ? ['draft'] : [])];
    return `opened by ${by}${where.length > 0 ? ` (${where.join(', ')})` : ''}`;
}
