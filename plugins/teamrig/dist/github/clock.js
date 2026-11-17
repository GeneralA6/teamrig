/**
 * The response clock on GitHub threads (T3021 section 4, slice E): how long an outsider has waited for an answer of
 * ours in words, against a target per kind of thread. Code keeps it at 0 tokens: at REMIND_SHARE of the target the
 * owning session gets one unwoken inbox line, at the target `teamrig check` raises GH-LATE for the lead. Pure: the
 * sync reads the threads and keeps the clocks in their own state file (src/cli/commands/issue-clock.ts).
 */
import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { isInsideAuthor, isOurAuthor } from "./trust.js";
/** The kinds of thread, each with its own answer target. */
export const THREAD_KINDS = ['security', 'bug', 'pull', 'comment', 'feature'];
const HOUR_MS = 3_600_000;
/**
 * How long each kind may wait for an answer in words (the design's table): a security report 4 h, a bug from outside,
 * a contributor's pull request and a comment on a thread we hold 24 h, a feature ask or a question 72 h.
 */
export const ANSWER_TARGET_HOURS = { security: 4, bug: 24, pull: 24, comment: 24, feature: 72 };
/** The share of its target a thread waits before its owner is reminded, once. */
export const REMIND_SHARE = 0.75;
/**
 * When the thread started waiting on us: its oldest outside post after our newest one, or undefined when we spoke
 * last or no outsider posted. The oldest, not the newest: a "any news?" follow-up must not restart the wait.
 */
export function waitingSince(posts) {
    const ordered = [...posts].sort((a, b) => a.at - b.at);
    const lastOurs = ordered.findLastIndex((post) => post.ours);
    return ordered.slice(lastOurs + 1).find((post) => !post.ours)?.at;
}
/** A clock's target in milliseconds. */
export function targetMs(kind) {
    return ANSWER_TARGET_HOURS[kind] * HOUR_MS;
}
/** Whether a clock passed its target at `now`. */
export function isLate(clock, now) {
    return now - clock.since >= targetMs(clock.kind);
}
/**
 * The clocks after a read of the repositories in `read`: each open thread waiting on us keeps its clock (and whether
 * it was reminded) while the wait it times is the same one, else starts a fresh one; a thread answered, closed or
 * gone stops its clock. A repository not read this time (it failed) keeps its clocks as they were. A clock past
 * REMIND_SHARE of its target that was never reminded is reminded now, once.
 */
export function stepClocks(before, read, threads, now) {
    const clocks = new Map([...before].filter(([, clock]) => !read.has(clock.repo)));
    const remind = [];
    for (const thread of threads) {
        const since = waitingSince(thread.posts);
        if (since === undefined) {
            continue;
        }
        const kept = before.get(thread.ref);
        const remindedAt = kept?.since === since ? kept.remindedAt : undefined;
        const clock = { repo: thread.repo, ref: thread.ref, kind: thread.kind, owner: thread.owner, since, remindedAt };
        if (clock.remindedAt === undefined && now - since >= targetMs(clock.kind) * REMIND_SHARE) {
            const reminded = { ...clock, remindedAt: now };
            remind.push(reminded);
            clocks.set(thread.ref, reminded);
        }
        else {
            clocks.set(thread.ref, clock);
        }
    }
    return { clocks, remind };
}
/**
 * An open issue as a thread: its opening post and its comments read, a bot's left out, each ours by postIsOurs; `owner`
 * answers it. Its kind by label (`security`, then `bug`, matched without case), else a comment on a thread we hold
 * (`held`: a task of ours tracks it), else a feature ask or question. Undefined for a closed one.
 */
export function issueThread(issue, ref, owner, held, ours) {
    if (issue.state !== 'open') {
        return undefined;
    }
    const opening = issue.createdAt === undefined || issue.authorKind === BOT ? [] : [{ at: issue.createdAt, association: issue.authorAssociation, login: issue.author }];
    const comments = issue.comments.filter((comment) => comment.authorKind !== BOT).map((comment) => ({ at: comment.at, association: comment.authorAssociation, login: comment.login }));
    const posts = [...opening, ...comments].map((post) => ({ at: Date.parse(post.at), ours: postIsOurs(post.association, post.login, ours) }));
    return { repo: issue.repo, ref, kind: issueKind(issue.labels, held), owner, posts };
}
/**
 * Whether a post is the team's answer. With `github.owners` naming the team's people, only their logins and the
 * repository's owner answer (isOurAuthor): an outside contributor given collaborator access still waits on us, and
 * their follow-up is no answer. A team that named no one falls back to the author's tie to the repository
 * (isInsideAuthor).
 */
export function postIsOurs(association, login, ours) {
    return ours.size === 0 ? isInsideAuthor(association) : isOurAuthor(association, login, ours);
}
/** An app's or a workflow's account kind: its posts are no one's answer and no one's ask. */
const BOT = 'Bot';
function issueKind(labels, held) {
    const has = (name) => labels.some((label) => label.toLowerCase() === name);
    if (has('security')) {
        return 'security';
    }
    if (has('bug')) {
        return 'bug';
    }
    return held ? 'comment' : 'feature';
}
/** The format of the clocks file this code writes; a file in another format, or damaged, reads as no clock running. */
export const CLOCK_STATE_FORMAT = 1;
/** The clocks a file holds by ref; a damaged entry is left out, a damaged file reads as none. */
export function parseClocks(text) {
    const record = parseObject(text.trim());
    const list = record?.[VERSION_FIELD] === CLOCK_STATE_FORMAT ? record['clocks'] : undefined;
    const clocks = Array.isArray(list) ? list.flatMap(clockOf) : [];
    return new Map(clocks.map((clock) => [clock.ref, clock]));
}
function clockOf(value) {
    if (!isRecord(value)) {
        return [];
    }
    const { repo, ref, kind, owner, since, remindedAt } = value;
    const time = (at) => typeof at === 'number' && Number.isFinite(at);
    if (typeof repo !== 'string' || typeof ref !== 'string' || typeof owner !== 'string' || !isThreadKind(kind) || !time(since)) {
        return [];
    }
    return [{ repo, ref, kind, owner, since, remindedAt: time(remindedAt) ? remindedAt : undefined }];
}
function isThreadKind(value) {
    return THREAD_KINDS.some((kind) => kind === value);
}
export function formatClocks(clocks) {
    return toJsonlLine({
        [VERSION_FIELD]: CLOCK_STATE_FORMAT,
        clocks: [...clocks.values()].map(({ repo, ref, kind, owner, since, remindedAt }) => ({ repo, ref, kind, owner, since, ...(remindedAt === undefined ? {} : { remindedAt }) })),
    });
}
/** How long a clock has run, in whole hours. */
function waitedHours(clock, now) {
    return Math.floor((now - clock.since) / HOUR_MS);
}
/** The owner's unwoken reminder at REMIND_SHARE of the target. */
export function reminderText(clock, now, zone) {
    const due = new Date(clock.since + targetMs(clock.kind));
    return (`GitHub ${clock.ref} (${clock.kind}) has waited ${waitedHours(clock, now)} h for an answer of ours, since ${zone.shortMinute(new Date(clock.since))}; ` +
        `answer it in words on GitHub by ${zone.shortMinute(due)}, its ${ANSWER_TARGET_HOURS[clock.kind]} h target, or GH-LATE goes to the lead`);
}
/** The lead's GH-LATE line for a clock past its target. */
export function lateText(clock, now, zone) {
    return (`GH-LATE ${clock.ref} (${clock.kind}, ${clock.owner}) has waited ${waitedHours(clock, now)} h for an answer of ours since ` +
        `${zone.shortMinute(new Date(clock.since))}, past its ${ANSWER_TARGET_HOURS[clock.kind]} h target: have ${clock.owner} answer it on GitHub`);
}
