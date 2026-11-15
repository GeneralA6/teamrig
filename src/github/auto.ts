import { isRecord, stringField } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { PULL_CHECKS, PULL_MERGEABLE, PULL_REVIEWS } from '../issues/pull.ts';
import { cut } from '../register/views.ts';
import { issueRef } from './map.ts';
import type { PullEvent, PullMark, PullWatch } from './pull-news.ts';
import { pagedNumbers, type SecurityIssue } from './security-alert.ts';
import type { StepOutcome } from './sync.ts';

/**
 * The automatic GitHub sync's decisions, kept pure (`issue watch` decides when one runs, github/watch.ts): what the
 * owners hear about the tasks it added (`addedLines`), what the lead hears about the repositories it
 * could not read (`failureNews`, only when that set changes, so a lasting failure is told once) and about the
 * outsiders' issues it left out (`leftOutNews`, only for a number not left out before). Pull request news is
 * decided in pull-news.ts.
 */

/**
 * The format of the sync state file this code writes: 2 added `leftOut`, 3 `pulls`, 4 `paged`. It reads format 1 as
 * having left nothing out, formats 1 and 2 as having watched no pull request, so the next read of each is a first read,
 * and formats 1 to 3 as having paged no security issue, so each one open pages once; a file in another format reads as
 * no sync yet.
 */
export const SYNC_STATE_FORMAT = 4;
/** The older formats this code still reads. */
const NO_LEFT_OUT_FORMAT = 1;
const NO_PULLS_FORMAT = 2;
const NO_PAGED_FORMAT = 3;

/** The new tasks one inbox line names; the rest are counted. */
const NAMED_TASKS = 5;
/** The new left-out issues the lead's line names; the rest are counted. */
const NAMED_LEFT_OUT = 10;
/** How much of an issue title an inbox line repeats. */
const TITLE_CHARS = 60;

/**
 * The team's automatic sync: when the last one started and finished, the repositories it could not read, by
 * repository the numbers, lowest first, of the open issues the trust rule left out (github/trust.ts), by repository
 * what the pull request monitor last read (pull-news.ts), and by repository the numbers, lowest first, of the open
 * security issues the owner was paged for (security-alert.ts).
 */
export interface SyncState {
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly failing: readonly string[];
  readonly leftOut: ReadonlyMap<string, readonly number[]>;
  readonly pulls: ReadonlyMap<string, PullWatch>;
  readonly paged: ReadonlyMap<string, readonly number[]>;
}

/**
 * What one `issue sync --auto` run did: the tasks it added, the repositories that failed, the issues it left out of
 * each repository it read, what it read of the pull requests of each repository whose pull requests it read, and
 * the pull request events each session hears about (pull-news.ts), and the open security issues of each repository
 * whose issues it read (security-alert.ts).
 */
export interface SyncRun {
  readonly added: readonly AddedTask[];
  readonly failures: readonly RepoFailure[];
  readonly leftOut: ReadonlyMap<string, readonly number[]>;
  readonly pulls: ReadonlyMap<string, PullWatch>;
  readonly pullNews: ReadonlyMap<string, readonly PullEvent[]>;
  readonly security: ReadonlyMap<string, readonly SecurityIssue[]>;
}

/** A repository a sync could not read, or whose tasks the task list refused, and why. */
export interface RepoFailure {
  readonly repo: string;
  readonly reason: string;
}

/** A task a sync added for an issue. */
export interface AddedTask {
  readonly id: string;
  readonly owner: string;
  readonly ref: string;
  readonly title: string;
}

/**
 * The state file's content; undefined when it is damaged or from another format, which reads as no sync yet. A
 * format-1 file left nothing out, neither format 1 nor 2 watched a pull request, and no older format paged.
 */
export function parseSyncState(text: string): SyncState | undefined {
  const record = parseObject(text.trim());
  const format = record?.[VERSION_FIELD];
  if (record === undefined || (format !== SYNC_STATE_FORMAT && format !== NO_PAGED_FORMAT && format !== NO_PULLS_FORMAT && format !== NO_LEFT_OUT_FORMAT)) {
    return undefined;
  }
  const { startedAt, finishedAt, failing } = record;
  if (!isTime(startedAt) || !(finishedAt === undefined || isTime(finishedAt)) || !Array.isArray(failing)) {
    return undefined;
  }
  const repos = failing.filter((repo): repo is string => typeof repo === 'string');
  const leftOut = format === NO_LEFT_OUT_FORMAT ? new Map<string, readonly number[]>() : parseNumbers(record['leftOut']);
  const pulls = format === SYNC_STATE_FORMAT || format === NO_PAGED_FORMAT ? parsePulls(record['pulls']) : new Map<string, PullWatch>();
  const paged = format === SYNC_STATE_FORMAT ? parseNumbers(record['paged']) : new Map<string, readonly number[]>();
  return repos.length === failing.length && leftOut !== undefined && pulls !== undefined && paged !== undefined
    ? { startedAt, finishedAt, failing: repos, leftOut, pulls, paged }
    : undefined;
}

/** The stored `pulls` object, which a file holds only once some repository's pull requests were read; undefined when damaged. */
function parsePulls(value: unknown): Map<string, PullWatch> | undefined {
  if (value === undefined) {
    return new Map();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const pulls = new Map(
    entries.flatMap(([repo, watch]) => {
      const parsed = parseWatch(watch);
      return parsed === undefined ? [] : [[repo, parsed] as const];
    }),
  );
  return pulls.size === entries.length ? pulls : undefined;
}

function parseWatch(value: unknown): PullWatch | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const cursor = stringField(value, 'cursor');
  const open = value['open'];
  if ((value['cursor'] !== undefined && (cursor === undefined || Number.isNaN(Date.parse(cursor)))) || !Array.isArray(open)) {
    return undefined;
  }
  const marks = open.flatMap((mark: unknown) => {
    const parsed = parseMark(mark);
    return parsed === undefined ? [] : [parsed];
  });
  return marks.length === open.length ? { cursor, open: marks } : undefined;
}

function parseMark(value: unknown): PullMark | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { number, mergeable, checks, review } = value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return undefined;
  }
  return isOneOf(PULL_MERGEABLE, mergeable) && isOneOf(PULL_CHECKS, checks) && isOneOf(PULL_REVIEWS, review) ? { number, mergeable, checks, review } : undefined;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.some((item) => item === value);
}

/** A stored issue numbers object by repository (`leftOut`, `paged`), which a file holds only when one is not empty; undefined when damaged. */
function parseNumbers(value: unknown): Map<string, readonly number[]> | undefined {
  if (value === undefined) {
    return new Map();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const leftOut = new Map(entries.flatMap(([repo, numbers]) => (isIssueNumbers(numbers) ? [[repo, numbers] as const] : [])));
  return leftOut.size === entries.length ? leftOut : undefined;
}

function isIssueNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((number) => Number.isSafeInteger(number) && number > 0);
}

export function formatSyncState(state: SyncState): string {
  return toJsonlLine({
    [VERSION_FIELD]: SYNC_STATE_FORMAT,
    startedAt: state.startedAt,
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    failing: [...state.failing],
    ...(state.leftOut.size === 0 ? {} : { leftOut: Object.fromEntries([...state.leftOut].map(([repo, numbers]) => [repo, [...numbers]])) }),
    ...(state.pulls.size === 0 ? {} : { pulls: Object.fromEntries([...state.pulls].map(([repo, watch]) => [repo, watchRecord(watch)])) }),
    ...(state.paged.size === 0 ? {} : { paged: Object.fromEntries([...state.paged].map(([repo, numbers]) => [repo, [...numbers]])) }),
  });
}

function watchRecord(watch: PullWatch): Record<string, unknown> {
  return { ...(watch.cursor === undefined ? {} : { cursor: watch.cursor }), open: watch.open.map((mark) => ({ ...mark })) };
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * What a finished sync writes: its start as claimed (now, for a sync run by hand), the repositories that failed,
 * the issues left out of each repository it read, and what it read of each one's pull requests. A repository it
 * could not read keeps what was left out of it before, so its issues are not told again once it reads, and its pull
 * request watch, so what happened meanwhile is news once it reads; one that left nothing out is not kept, nor the
 * watch of a repository no longer synced. The paged numbers of a repository it read are its open security issues now,
 * every one of them paged by this run or before; one it could not read keeps its own, so none pages twice.
 */
export function finishState(state: SyncState | undefined, now: number, run: Pick<SyncRun, 'failures' | 'leftOut' | 'pulls' | 'security'>): SyncState {
  const failing = run.failures.map((failure) => failure.repo);
  const kept = [...(state?.leftOut ?? [])].filter(([repo]) => failing.includes(repo) && !run.leftOut.has(repo));
  const watched = [...(state?.pulls ?? [])].filter(([repo]) => failing.includes(repo) && !run.pulls.has(repo));
  const pagedBefore = [...(state?.paged ?? [])].filter(([repo]) => failing.includes(repo) && !run.security.has(repo));
  return {
    startedAt: state?.startedAt ?? now,
    finishedAt: now,
    failing,
    leftOut: new Map([...run.leftOut, ...kept].filter(([, numbers]) => numbers.length > 0)),
    pulls: new Map([...run.pulls, ...watched]),
    paged: new Map([...pagedNumbers(run.security), ...pagedBefore]),
  };
}

/** The tasks the written steps added, each with the owner and title it was added with. */
export function addedTasks(outcomes: readonly StepOutcome[]): AddedTask[] {
  return outcomes.flatMap(({ step, result }) =>
    step.kind === 'add' && result.ok ? [{ id: result.value, owner: step.input.owner, ref: step.ref, title: step.input.title }] : [],
  );
}

/** One inbox line per owner naming the tasks a sync added for it, by owner in the order first seen. */
export function addedLines(added: readonly AddedTask[]): ReadonlyMap<string, string> {
  const byOwner = new Map<string, AddedTask[]>();
  for (const task of added) {
    byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task]);
  }
  return new Map([...byOwner].map(([owner, tasks]) => [owner, addedText(tasks)]));
}

/** An issue title is outside input: it is quoted, as data, and cut short. */
function addedText(tasks: readonly AddedTask[]): string {
  const named = tasks.slice(0, NAMED_TASKS).map((task) => `${task.id} ${task.ref} ${JSON.stringify(cut(task.title, TITLE_CHARS))}`);
  const more = tasks.length - named.length;
  return `GitHub sync added ${tasks.length} task(s) for you: ${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

/**
 * The lead's line when the failing repositories changed: those newly failing, with why, or, once every
 * repository reads again, that it does. A repository still failing is not told again.
 */
export function failureNews(before: readonly string[], failures: readonly RepoFailure[]): string | undefined {
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
export function leftOutNews(
  before: ReadonlyMap<string, readonly number[]>,
  now: ReadonlyMap<string, readonly number[]>,
  acceptLabel: string,
): string | undefined {
  const fresh = [...now].flatMap(([repo, numbers]) => numbers.filter((number) => !(before.get(repo) ?? []).includes(number)).map((number) => issueRef(repo, number)));
  if (fresh.length === 0) {
    return undefined;
  }
  const more = fresh.length - NAMED_LEFT_OUT;
  return (
    `GitHub sync left out ${fresh.length} new open issue(s) by people outside the repository: ${fresh.slice(0, NAMED_LEFT_OUT).join(', ')}` +
    `${more > 0 ? `, and ${more} more` : ''}; add the ${JSON.stringify(acceptLabel)} label to one on GitHub to make it a task at the next sync`
  );
}
