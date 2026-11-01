import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { cut } from "../register/views.js";
import { issueRef } from "./map.js";
/**
 * The automatic GitHub sync's decisions, kept pure: when the hooks start the next one (`isDue`), what the
 * owners hear about the tasks it added (`addedLines`), what the lead hears about the repositories it
 * could not read (`failureNews`, only when that set changes, so a lasting failure is told once) and about the
 * outsiders' issues it left out (`leftOutNews`, only for a number not left out before).
 */
/**
 * The format of the sync state file this code writes: 2 added `leftOut`. It reads format 1 as having left
 * nothing out; a file in another format reads as no sync yet.
 */
export const SYNC_STATE_FORMAT = 2;
/** The older format this code still reads. */
const NO_LEFT_OUT_FORMAT = 1;
const MINUTE_MS = 60_000;
/** The new tasks one inbox line names; the rest are counted. */
const NAMED_TASKS = 5;
/** The new left-out issues the lead's line names; the rest are counted. */
const NAMED_LEFT_OUT = 10;
/** How much of an issue title an inbox line repeats. */
const TITLE_CHARS = 60;
/**
 * The state file's content; undefined when it is damaged or from another format, which reads as no sync yet. A
 * format-1 file left nothing out.
 */
export function parseSyncState(text) {
    const record = parseObject(text.trim());
    const format = record?.[VERSION_FIELD];
    if (record === undefined || (format !== SYNC_STATE_FORMAT && format !== NO_LEFT_OUT_FORMAT)) {
        return undefined;
    }
    const { startedAt, finishedAt, failing } = record;
    if (!isTime(startedAt) || !(finishedAt === undefined || isTime(finishedAt)) || !Array.isArray(failing)) {
        return undefined;
    }
    const repos = failing.filter((repo) => typeof repo === 'string');
    const leftOut = format === NO_LEFT_OUT_FORMAT ? new Map() : parseLeftOut(record['leftOut']);
    return repos.length === failing.length && leftOut !== undefined ? { startedAt, finishedAt, failing: repos, leftOut } : undefined;
}
/** The stored `leftOut` object, which a file holds only when some issue was left out; undefined when damaged. */
function parseLeftOut(value) {
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
    });
}
function isTime(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/**
 * Whether a hook starts a sync now: `everyMinutes` have passed since the last start, finished or not, so a
 * run that died is retried at the next interval. A start dated ahead of now (the clock went back) does not
 * hold the next one off; 0 minutes never starts one.
 */
export function isDue(state, now, everyMinutes) {
    if (everyMinutes <= 0) {
        return false;
    }
    return state === undefined || now < state.startedAt || now - state.startedAt >= everyMinutes * MINUTE_MS;
}
/** What a hook writes before it starts a sync, so no other hook starts one in the same interval. */
export function claimState(state, now) {
    return { startedAt: now, finishedAt: state?.finishedAt, failing: state?.failing ?? [], leftOut: state?.leftOut ?? new Map() };
}
/**
 * What a finished sync writes: its start as claimed (now, for a sync run by hand), the repositories that failed,
 * and the issues left out of each repository it read. A repository it could not read keeps what was left out
 * of it before, so its issues are not told again once it reads; one that left nothing out is not kept.
 */
export function finishState(state, now, failures, leftOut) {
    const failing = failures.map((failure) => failure.repo);
    const kept = [...(state?.leftOut ?? [])].filter(([repo]) => failing.includes(repo) && !leftOut.has(repo));
    return {
        startedAt: state?.startedAt ?? now,
        finishedAt: now,
        failing,
        leftOut: new Map([...leftOut, ...kept].filter(([, numbers]) => numbers.length > 0)),
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
