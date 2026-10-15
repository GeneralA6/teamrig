import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { cut } from '../register/views.ts';
import type { StepOutcome } from './sync.ts';

/**
 * The automatic GitHub sync's decisions, kept pure: when the hooks start the next one (`isDue`), what the
 * owners hear about the tasks it added (`addedLines`) and what the lead hears about the repositories it
 * could not read (`failureNews`, only when that set changes, so a lasting failure is told once).
 */

/** The format of the sync state file this code reads and writes; a file in another format reads as no sync yet. */
export const SYNC_STATE_FORMAT = 1;

const MINUTE_MS = 60_000;
/** The new tasks one inbox line names; the rest are counted. */
const NAMED_TASKS = 5;
/** How much of an issue title an inbox line repeats. */
const TITLE_CHARS = 60;

/** The team's automatic sync: when the last one started and finished, and the repositories it could not read. */
export interface SyncState {
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly failing: readonly string[];
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

/** The state file's content; undefined when it is damaged or from another format, which reads as no sync yet. */
export function parseSyncState(text: string): SyncState | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== SYNC_STATE_FORMAT) {
    return undefined;
  }
  const { startedAt, finishedAt, failing } = record;
  if (!isTime(startedAt) || !(finishedAt === undefined || isTime(finishedAt)) || !Array.isArray(failing)) {
    return undefined;
  }
  const repos = failing.filter((repo): repo is string => typeof repo === 'string');
  return repos.length === failing.length ? { startedAt, finishedAt, failing: repos } : undefined;
}

export function formatSyncState(state: SyncState): string {
  return toJsonlLine({
    [VERSION_FIELD]: SYNC_STATE_FORMAT,
    startedAt: state.startedAt,
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    failing: [...state.failing],
  });
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether a hook starts a sync now: `everyMinutes` have passed since the last start, finished or not, so a
 * run that died is retried at the next interval. A start dated ahead of now (the clock went back) does not
 * hold the next one off; 0 minutes never starts one.
 */
export function isDue(state: SyncState | undefined, now: number, everyMinutes: number): boolean {
  if (everyMinutes <= 0) {
    return false;
  }
  return state === undefined || now < state.startedAt || now - state.startedAt >= everyMinutes * MINUTE_MS;
}

/** What a hook writes before it starts a sync, so no other hook starts one in the same interval. */
export function claimState(state: SyncState | undefined, now: number): SyncState {
  return { startedAt: now, finishedAt: state?.finishedAt, failing: state?.failing ?? [] };
}

/** What a finished sync writes: its start as claimed (now, for a sync run by hand) and the repositories that failed. */
export function finishState(state: SyncState | undefined, now: number, failures: readonly RepoFailure[]): SyncState {
  return { startedAt: state?.startedAt ?? now, finishedAt: now, failing: failures.map((failure) => failure.repo) };
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
