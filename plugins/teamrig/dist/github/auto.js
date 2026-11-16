import { isRecord, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { PULL_CHECKS, PULL_MERGEABLE, PULL_REVIEWS } from "../issues/pull.js";
import { cut } from "../register/views.js";
import { issueRef } from "./map.js";
import { pagedAfter } from "./security-alert.js";
/**
 * The automatic GitHub sync's decisions, kept pure (`issue watch` decides when one runs, github/watch.ts): what the
 * owners hear about the tasks it added (`addedLines`), what the lead hears about the repositories it
 * could not read (`failureNews`, only when that set changes, so a lasting failure is told once) and about the
 * outsiders' issues it left out (`leftOutNews`, only for a number not left out before). Pull request news is
 * decided in pull-news.ts.
 */
/**
 * The format of the sync state file this code writes: 2 added `leftOut`, 3 `pulls`, 4 `paged`, 5 `mentions` and
 * `mentionWakes`. It reads format 1 as having left nothing out, formats 1 and 2 as having watched no pull request, so the
 * next read of each is a first read, formats 1 to 3 as having paged no security issue, so each one open pages once, and
 * formats 1 to 4 as having watched no mention, so each repository's scan starts at its next read; a file in another
 * format reads as no sync yet.
 */
export const SYNC_STATE_FORMAT = 5;
/** The older formats this code still reads. */
const NO_LEFT_OUT_FORMAT = 1;
const NO_PULLS_FORMAT = 2;
const NO_PAGED_FORMAT = 3;
const NO_MENTIONS_FORMAT = 4;
const READ_FORMATS = [NO_LEFT_OUT_FORMAT, NO_PULLS_FORMAT, NO_PAGED_FORMAT, NO_MENTIONS_FORMAT, SYNC_STATE_FORMAT];
/** The new tasks one inbox line names; the rest are counted. */
const NAMED_TASKS = 5;
/** The new left-out issues the lead's line names; the rest are counted. */
const NAMED_LEFT_OUT = 10;
/** How much of an issue title an inbox line repeats. */
const TITLE_CHARS = 60;
/**
 * The state file's content; undefined when it is damaged or from another format, which reads as no sync yet. A
 * format-1 file left nothing out, neither format 1 nor 2 watched a pull request, no format before 4 paged, and none
 * before 5 watched a mention.
 */
export function parseSyncState(text) {
    const record = parseObject(text.trim());
    const format = record?.[VERSION_FIELD];
    if (record === undefined || !isOneOf(READ_FORMATS, format)) {
        return undefined;
    }
    const { startedAt, finishedAt, failing } = record;
    if (!isTime(startedAt) || !(finishedAt === undefined || isTime(finishedAt)) || !Array.isArray(failing)) {
        return undefined;
    }
    const repos = failing.filter((repo) => typeof repo === 'string');
    const leftOut = format === NO_LEFT_OUT_FORMAT ? new Map() : parseNumbers(record['leftOut']);
    const pulls = format === NO_LEFT_OUT_FORMAT || format === NO_PULLS_FORMAT ? new Map() : parsePulls(record['pulls']);
    const paged = format === SYNC_STATE_FORMAT || format === NO_MENTIONS_FORMAT ? parseNumbers(record['paged']) : new Map();
    const mentions = format === SYNC_STATE_FORMAT ? parseMentions(record['mentions']) : new Map();
    const mentionWakes = format === SYNC_STATE_FORMAT ? parseWakes(record['mentionWakes']) : new Map();
    return repos.length === failing.length && leftOut !== undefined && pulls !== undefined && paged !== undefined && mentions !== undefined && mentionWakes !== undefined
        ? { startedAt, finishedAt, failing: repos, leftOut, pulls, paged, mentions, mentionWakes }
        : undefined;
}
/** The stored `pulls` object, which a file holds only once some repository's pull requests were read; undefined when damaged. */
function parsePulls(value) {
    if (value === undefined) {
        return new Map();
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    const pulls = new Map(entries.flatMap(([repo, watch]) => {
        const parsed = parseWatch(watch);
        return parsed === undefined ? [] : [[repo, parsed]];
    }));
    return pulls.size === entries.length ? pulls : undefined;
}
function parseWatch(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const cursor = stringField(value, 'cursor');
    const open = value['open'];
    if ((value['cursor'] !== undefined && (cursor === undefined || Number.isNaN(Date.parse(cursor)))) || !Array.isArray(open)) {
        return undefined;
    }
    const marks = open.flatMap((mark) => {
        const parsed = parseMark(mark);
        return parsed === undefined ? [] : [parsed];
    });
    return marks.length === open.length ? { cursor, open: marks } : undefined;
}
function parseMark(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { number, mergeable, checks, review } = value;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
        return undefined;
    }
    return isOneOf(PULL_MERGEABLE, mergeable) && isOneOf(PULL_CHECKS, checks) && isOneOf(PULL_REVIEWS, review) ? { number, mergeable, checks, review } : undefined;
}
/** The stored `mentions` object, which a file holds only once some repository's posts were read; undefined when damaged. */
function parseMentions(value) {
    if (value === undefined) {
        return new Map();
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    const mentions = new Map(entries.flatMap(([repo, watch]) => {
        const parsed = parseMentionWatch(watch);
        return parsed === undefined ? [] : [[repo, parsed]];
    }));
    return mentions.size === entries.length ? mentions : undefined;
}
function parseMentionWatch(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const cursor = stringField(value, 'cursor');
    const seen = value['seen'];
    if (cursor === undefined || Number.isNaN(Date.parse(cursor)) || !isRecord(seen)) {
        return undefined;
    }
    const entries = Object.entries(seen);
    const marks = new Map(entries.flatMap(([key, mark]) => {
        const parsed = parseSeen(mark);
        return parsed === undefined ? [] : [[key, parsed]];
    }));
    return marks.size === entries.length ? { cursor, seen: marks } : undefined;
}
function parseSeen(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const updatedAt = stringField(value, 'updatedAt');
    const logins = value['logins'];
    return updatedAt !== undefined && !Number.isNaN(Date.parse(updatedAt)) && isLogins(logins) ? { logins, updatedAt } : undefined;
}
function isLogins(value) {
    return Array.isArray(value) && value.every((login) => typeof login === 'string');
}
/** The stored `mentionWakes` object, by `<session> <ref>` the time it was woken; undefined when damaged. */
function parseWakes(value) {
    if (value === undefined) {
        return new Map();
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    const wakes = new Map(entries.flatMap(([key, at]) => (isTime(at) ? [[key, at]] : [])));
    return wakes.size === entries.length ? wakes : undefined;
}
function isOneOf(list, value) {
    return list.some((item) => item === value);
}
/** A stored issue numbers object by repository (`leftOut`, `paged`), which a file holds only when one is not empty; undefined when damaged. */
function parseNumbers(value) {
    if (value === undefined) {
        return new Map();
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    const leftOut = new Map(entries.flatMap(([repo, numbers]) => (isIssueNumbers(numbers) ? [[repo, numbers]] : [])));
    return leftOut.size === entries.length ? leftOut : undefined;
}
function isIssueNumbers(value) {
    return Array.isArray(value) && value.every((number) => Number.isSafeInteger(number) && number > 0);
}
export function formatSyncState(state) {
    return toJsonlLine({
        [VERSION_FIELD]: SYNC_STATE_FORMAT,
        startedAt: state.startedAt,
        ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
        failing: [...state.failing],
        ...(state.leftOut.size === 0 ? {} : { leftOut: Object.fromEntries([...state.leftOut].map(([repo, numbers]) => [repo, [...numbers]])) }),
        ...(state.pulls.size === 0 ? {} : { pulls: Object.fromEntries([...state.pulls].map(([repo, watch]) => [repo, watchRecord(watch)])) }),
        ...(state.paged.size === 0 ? {} : { paged: Object.fromEntries([...state.paged].map(([repo, numbers]) => [repo, [...numbers]])) }),
        ...(state.mentions.size === 0 ? {} : { mentions: Object.fromEntries([...state.mentions].map(([repo, watch]) => [repo, mentionRecord(watch)])) }),
        ...(state.mentionWakes.size === 0 ? {} : { mentionWakes: Object.fromEntries(state.mentionWakes) }),
    });
}
function watchRecord(watch) {
    return { ...(watch.cursor === undefined ? {} : { cursor: watch.cursor }), open: watch.open.map((mark) => ({ ...mark })) };
}
function mentionRecord(watch) {
    return { cursor: watch.cursor, seen: Object.fromEntries([...watch.seen].map(([key, mark]) => [key, { logins: [...mark.logins], updatedAt: mark.updatedAt }])) };
}
function isTime(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/**
 * What a finished sync writes: its start as claimed (now, for a sync run by hand), the repositories that failed,
 * the issues left out of each repository it read, and what it read of each one's pull requests. A repository it
 * could not read keeps what was left out of it before, so its issues are not told again once it reads, and its pull
 * request watch, so what happened meanwhile is news once it reads; one that left nothing out is not kept, nor the
 * watch of a repository no longer synced. The paged numbers are kept for good, with those of the open security issues
 * this run found added (`pagedAfter`), so none pages twice. A repository whose posts it could not read keeps its mention
 * watch, so its scan goes on from there; `mentionWakes` are the wakes after this run's (`wakeRoutes`).
 */
export function finishState(state, now, run, mentionWakes) {
    const failing = run.failures.map((failure) => failure.repo);
    const kept = [...(state?.leftOut ?? [])].filter(([repo]) => failing.includes(repo) && !run.leftOut.has(repo));
    const watched = [...(state?.pulls ?? [])].filter(([repo]) => failing.includes(repo) && !run.pulls.has(repo));
    const scanned = [...(state?.mentions ?? [])].filter(([repo]) => failing.includes(repo) && !run.mentions.has(repo));
    return {
        startedAt: state?.startedAt ?? now,
        finishedAt: now,
        failing,
        leftOut: new Map([...run.leftOut, ...kept].filter(([, numbers]) => numbers.length > 0)),
        pulls: new Map([...run.pulls, ...watched]),
        paged: pagedAfter(state?.paged ?? new Map(), run.security),
        mentions: new Map([...run.mentions, ...scanned]),
        mentionWakes,
    };
}
/** The tasks the written steps added, each with the owner and title it was added with. */
export function addedTasks(outcomes) {
    return outcomes.flatMap(({ step, result }) => step.kind === 'add' && result.ok ? [{ id: result.value, owner: step.input.owner, ref: step.ref, title: step.input.title }] : []);
}
/** One inbox line per owner naming the tasks a sync added for it, by owner in the order first seen. */
export function addedLines(added) {
    const byOwner = new Map();
    for (const task of added) {
        byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task]);
    }
    return new Map([...byOwner].map(([owner, tasks]) => [owner, addedText(tasks)]));
}
/** An issue title is outside input: it is quoted, as data, and cut short. */
function addedText(tasks) {
    const named = tasks.slice(0, NAMED_TASKS).map((task) => `${task.id} ${task.ref} ${JSON.stringify(cut(task.title, TITLE_CHARS))}`);
    const more = tasks.length - named.length;
    return `GitHub sync added ${tasks.length} task(s) for you: ${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}
/**
 * The lead's line when the failing repositories changed: those newly failing, with why, or, once every
 * repository reads again, that it does. A repository still failing is not told again.
 */
export function failureNews(before, failures) {
    const fresh = failures.filter((failure) => !before.includes(failure.repo));
    if (fresh.length > 0) {
        const reasons = fresh.map((failure) => `${failure.repo} (${failure.reason.replace(/\s+/g, ' ')})`);
        return `GitHub sync could not read ${reasons.join('; ')}; it retries at each run and says here when every repository reads again`;
    }
    if (before.length > 0 && failures.length === 0) {
        return `GitHub sync reads every repository again (${before.join(', ')} failed before)`;
    }
    return undefined;
}
/**
 * The lead's line when a sync left out an open issue it had not left out before (`before`, the last sync's): the
 * new ones by ref, at most NAMED_LEFT_OUT, then how many more, and the label that lets one in. Never a title,
 * which is the outsider's text. Undefined when no number is new.
 */
export function leftOutNews(before, now, acceptLabel) {
    const fresh = [...now].flatMap(([repo, numbers]) => numbers.filter((number) => !(before.get(repo) ?? []).includes(number)).map((number) => issueRef(repo, number)));
    if (fresh.length === 0) {
        return undefined;
    }
    const more = fresh.length - NAMED_LEFT_OUT;
    return (`GitHub sync left out ${fresh.length} new open issue(s) by people outside the repository: ${fresh.slice(0, NAMED_LEFT_OUT).join(', ')}` +
        `${more > 0 ? `, and ${more} more` : ''}; add the ${JSON.stringify(acceptLabel)} label to one on GitHub to make it a task at the next sync`);
}
