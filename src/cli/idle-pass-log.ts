import type { IdleMode } from '../config/types.ts';
import type { CommitCharge } from '../delivery/memory.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../core/time.ts';
import type { PassStep } from './idle-pass.ts';

/**
 * The idle pass as the wake check runs it (T1100), kept pure: at most once every `IDLE_PASS_EVERY_MS` across the
 * team, and its log keeps what changed, and every step once its last pass record is `IDLE_PASS_LOG_EVERY_MS` old, so
 * a day of quiet passes writes one record an hour and a log silent for longer means the pass stopped (T1158). The
 * state file keeps the last pass's time, each session's step kind then and when a pass last logged its steps; a
 * failed pass keeps the kinds and its error, logged once until the error changes. It also keeps the acts a pass started, so the next passes start none on their sessions while
 * they may still run, the reopened tabs no hook started in that a pass told of, so it tells of each reopen once, and
 * the sessions a pass woke for work they could start and when, so a session still quiet after that wake closes.
 */

/**
 * The format of the pass's state file this code writes; it reads this one and format 1, from before the wakes
 * (T1247); a file in another format reads as no pass yet.
 */
export const IDLE_PASS_STATE_FORMAT = 2;

/** The state formats this code reads: format 1 holds no wake step and no woken sessions. */
const READ_STATE_FORMATS: readonly unknown[] = [1, IDLE_PASS_STATE_FORMAT];

/** The format of the pass log's records. */
export const IDLE_PASS_LOG_FORMAT = 1;

/** How often the wake checks run the pass, across the team. */
export const IDLE_PASS_EVERY_MS = MS_PER_MINUTE;

/** How old the last pass record may grow before a pass that changed nothing logs every step again. */
export const IDLE_PASS_LOG_EVERY_MS = MS_PER_HOUR;

export type PassKind = PassStep['kind'];

const PASS_KINDS: Readonly<Record<PassKind, true>> = { close: true, keep: true, wake: true, reopen: true, later: true, closed: true, away: true };

function isPassKind(value: unknown): value is PassKind {
  return typeof value === 'string' && Object.hasOwn(PASS_KINDS, value);
}

/** What a pass starts on one session: its close, or its reopen. */
export type IdleAct = 'close' | 'reopen';

/** An act a pass started, and when: the passes after it start none on its session while it may still run. */
export interface PendingAct {
  readonly act: IdleAct;
  readonly at: number;
}

/** A pass's wake of a quiet session for work it could start: when, and the tasks it named. */
export interface WokenMark {
  readonly at: number;
  readonly ids: readonly string[];
  /** Whether its line went out: none in dry-run or when the post failed, and mode `on` then wakes again (`wokenFor`). */
  readonly posted: boolean;
}

/**
 * The team's pass: when it last ran, each session's step kind at the last pass that ran through, the error of a
 * failing one, when a pass last logged its steps (none in a file from before T1158), the acts started that may still
 * run, the time of each hookless reopen told of (src/cli/hookless-reopen.ts), and each wake for work a session could
 * start (`wokenAfter`), by session.
 */
export interface IdlePassState {
  readonly at: number;
  readonly kinds: Readonly<Record<string, PassKind>>;
  readonly failed?: string;
  readonly logged?: number;
  readonly pending?: Readonly<Record<string, PendingAct>>;
  readonly told?: Readonly<Record<string, number>>;
  readonly woken?: Readonly<Record<string, WokenMark>>;
}

function isPendingAct(value: unknown): value is PendingAct {
  if (!isRecord(value)) {
    return false;
  }
  const { act, at } = value;
  return (act === 'close' || act === 'reopen') && typeof at === 'number' && Number.isFinite(at);
}

/** The pending acts of a state file: none when absent; undefined when one is damaged. */
function pendingOf(value: unknown): Readonly<Record<string, PendingAct>> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const known = entries.filter((entry): entry is [string, PendingAct] => isPendingAct(entry[1]));
  return known.length === entries.length ? Object.fromEntries(known) : undefined;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The reopens told of in a state file: none when absent (as in a file from before them); undefined when damaged. */
function toldOf(value: unknown): Readonly<Record<string, number>> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const known = entries.filter((entry): entry is [string, number] => isTime(entry[1]));
  return known.length === entries.length ? Object.fromEntries(known) : undefined;
}

function isWokenMark(value: unknown): value is WokenMark {
  if (!isRecord(value)) {
    return false;
  }
  const { at, ids, posted } = value;
  return isTime(at) && Array.isArray(ids) && ids.every((id) => typeof id === 'string') && typeof posted === 'boolean';
}

/** The wakes in a state file: none when absent (as in a file from before them); undefined when one is damaged. */
function wokenOf(value: unknown): Readonly<Record<string, WokenMark>> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const known = entries.filter((entry): entry is [string, WokenMark] => isWokenMark(entry[1]));
  return known.length === entries.length ? Object.fromEntries(known.map(([id, { at, ids, posted }]) => [id, { at, ids: [...ids], posted }])) : undefined;
}

/** The state file's content; undefined when it is damaged or from another format, which reads as no pass yet. */
export function parseIdlePassState(text: string): IdlePassState | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || !READ_STATE_FORMATS.includes(record[VERSION_FIELD])) {
    return undefined;
  }
  const { at, kinds, failed, logged } = record;
  const pending = pendingOf(record['pending']);
  const told = toldOf(record['told']);
  const woken = wokenOf(record['woken']);
  if (!isTime(at) || !isRecord(kinds) || (failed !== undefined && typeof failed !== 'string') || (logged !== undefined && !isTime(logged)) || pending === undefined || told === undefined || woken === undefined) {
    return undefined;
  }
  const entries = Object.entries(kinds);
  const known = entries.filter((entry): entry is [string, PassKind] => isPassKind(entry[1]));
  if (known.length !== entries.length) {
    return undefined;
  }
  return { at, kinds: Object.fromEntries(known), ...(failed === undefined ? {} : { failed }), ...loggedField(logged), ...pendingField(pending), ...toldField(told), ...wokenField(woken) };
}

/** When a pass last logged its steps, as a state field: none before the first. */
function loggedField(logged: number | undefined): { readonly logged?: number } {
  return logged === undefined ? {} : { logged };
}

/** The pending acts as a state field: none while nothing is pending. */
function pendingField(pending: Readonly<Record<string, PendingAct>> | undefined): { readonly pending?: Readonly<Record<string, PendingAct>> } {
  return pending === undefined || Object.keys(pending).length === 0 ? {} : { pending };
}

/** The reopens told of as a state field: none while no reopen is hookless. */
function toldField(told: Readonly<Record<string, number>> | undefined): { readonly told?: Readonly<Record<string, number>> } {
  return told === undefined || Object.keys(told).length === 0 ? {} : { told };
}

/** The wakes as a state field: none while no session is marked woken. */
function wokenField(woken: Readonly<Record<string, WokenMark>> | undefined): { readonly woken?: Readonly<Record<string, WokenMark>> } {
  return woken === undefined || Object.keys(woken).length === 0 ? {} : { woken };
}

export function formatIdlePassState(state: IdlePassState): string {
  const pending = Object.fromEntries(Object.entries(state.pending ?? {}).map(([id, { act, at }]) => [id, { act, at }]));
  const told = { ...state.told };
  const woken = Object.fromEntries(Object.entries(state.woken ?? {}).map(([id, { at, ids, posted }]) => [id, { at, ids: [...ids], posted }]));
  return toJsonlLine({
    [VERSION_FIELD]: IDLE_PASS_STATE_FORMAT,
    at: state.at,
    kinds: { ...state.kinds },
    ...(state.failed === undefined ? {} : { failed: state.failed }),
    ...loggedField(state.logged),
    ...pendingField(pending),
    ...toldField(told),
    ...wokenField(woken),
  });
}

/** Whether a wake check runs the pass now: `IDLE_PASS_EVERY_MS` passed since the last, or the clock went back past it. */
export function isPassDue(state: IdlePassState | undefined, now: number): boolean {
  return state === undefined || now < state.at || now - state.at >= IDLE_PASS_EVERY_MS;
}

/**
 * How long a team's pass may go unrun before a tab of another team of its tree runs it (T3387). An idle open tab of
 * the team runs it every `IDLE_PASS_EVERY_MS`; five missed in a row mean no tab of its own checks, as once the pass
 * closed its last session, and only a pass run from elsewhere can reopen one.
 */
export const TREE_PASS_AFTER_MS = 5 * IDLE_PASS_EVERY_MS;

/** Whether a tab of another team of the tree runs this team's pass now: `TREE_PASS_AFTER_MS` unrun, or the clock went back. */
export function isTreePassDue(state: IdlePassState | undefined, now: number): boolean {
  return state === undefined || now < state.at || now - state.at >= TREE_PASS_AFTER_MS;
}

/** How long the pass may go without running before `check` warns the lead (FLEET-STALE): fifteen missed passes. */
export const IDLE_PASS_STALE_MS = 15 * MS_PER_MINUTE;

/** Why a pass that is on needs the lead: it has not run for `IDLE_PASS_STALE_MS` since its last run, or that run failed. */
export type IdlePassTrouble = { readonly kind: 'stale'; readonly at: number } | { readonly kind: 'failed'; readonly at: number; readonly error: string };

/**
 * The trouble of a pass that is on; none while it ran within `IDLE_PASS_STALE_MS` and its last run went through. A
 * failed pass still advances `at`, so its age alone misses it; a clock gone back reads as a pass just run. A pass that
 * never ran has no time to be late from: a new team, or one just moved onto the pass by its default (T1409), waits for
 * its first idle tab, so its absence is no trouble; once it ran, its stopping is.
 */
export function idlePassTrouble(state: IdlePassState | undefined, now: number): IdlePassTrouble | undefined {
  if (state === undefined) {
    return undefined;
  }
  if (now - state.at > IDLE_PASS_STALE_MS) {
    return { kind: 'stale', at: state.at };
  }
  return state.failed === undefined ? undefined : { kind: 'failed', at: state.at, error: state.failed };
}

function minutesAgo(at: number, now: number): string {
  return `${Math.floor((now - at) / MS_PER_MINUTE)} min ago`;
}

/** `FLEET-STALE the idle pass (open.idle.mode dry-run) last ran 16 min ago: ...`, as `check --all` prints it. */
export function formatIdlePassTrouble(trouble: IdlePassTrouble, mode: IdleMode, now: number): string {
  const head = `FLEET-STALE the idle pass (open.idle.mode ${mode})`;
  if (trouble.kind === 'failed') {
    return `${head} failed at its last run, ${minutesAgo(trouble.at, now)}: ${trouble.error}; state/idle-pass.jsonl logs each new failure`;
  }
  return `${head} last ran ${minutesAgo(trouble.at, now)}: an idle tab's hook wake-check runs it at least every 10 minutes, so check wake.enabled and that the tabs' teamrig hooks run`;
}

/** The steps whose kind changed since the last pass that ran through; every step at the first. */
export function changedSteps(previous: IdlePassState | undefined, steps: readonly PassStep[]): PassStep[] {
  return steps.filter((step) => previous?.kinds[step.id] !== step.kind);
}

/**
 * The steps a pass logs: every one when no pass logged its steps yet, the last did `IDLE_PASS_LOG_EVERY_MS` ago or
 * more, or the clock went back past it; else only those whose kind changed (`changedSteps`).
 */
export function stepsToLog(previous: IdlePassState | undefined, steps: readonly PassStep[], now: number): PassStep[] {
  const logged = previous?.logged;
  return logged === undefined || now < logged || now - logged >= IDLE_PASS_LOG_EVERY_MS ? [...steps] : changedSteps(previous, steps);
}

/**
 * The state after a pass that ran through, with the acts still pending after it, the hookless reopens it found, each
 * told of: a session's mark goes once its tab had a hook, so a later hookless reopen of it is told of again, when
 * a pass last logged its steps, and the sessions marked woken (`wokenAfter`).
 */
export function passedState(
  now: number,
  steps: readonly PassStep[],
  pending: Readonly<Record<string, PendingAct>> = {},
  told: Readonly<Record<string, number>> = {},
  logged?: number,
  woken: Readonly<Record<string, WokenMark>> = {},
): IdlePassState {
  return {
    at: now,
    kinds: Object.fromEntries(steps.map((step): [string, PassKind] => [step.id, step.kind])),
    ...loggedField(logged),
    ...pendingField(pending),
    ...toldField(told),
    ...wokenField(woken),
  };
}

/**
 * The wakes kept after a pass (T1247, upstream #1354): each wake step marks its session woken now for the tasks it
 * names, and whether its line was `posted`; an earlier mark stays while its session's step is a keep, as it is while it answers the wake or stays quiet
 * under `open.headroom.closeIdleMinutes`. A close, a reopen, a closed or away session and one gone from the roster let
 * it go, so a session back from a close is woken again before it closes again.
 */
export function wokenAfter(previous: Readonly<Record<string, WokenMark>> | undefined, steps: readonly PassStep[], now: number, posted: ReadonlySet<string>): Record<string, WokenMark> {
  const woken: Record<string, WokenMark> = {};
  for (const step of steps) {
    const mark = previous?.[step.id];
    if (step.kind === 'wake') {
      woken[step.id] = { at: now, ids: [...step.ids], posted: posted.has(step.id) };
    } else if (step.kind === 'keep' && mark !== undefined) {
      woken[step.id] = mark;
    }
  }
  return woken;
}

/**
 * The state after a failed pass: the kinds of the last pass that ran through, so the next one logs its changes since,
 * when a pass last logged its steps, its pending acts, which only a pass that weighs the sessions can let go, and the
 * reopens it told of.
 */
export function failedState(previous: IdlePassState | undefined, now: number, error: string): IdlePassState {
  return { at: now, kinds: previous?.kinds ?? {}, failed: error, ...loggedField(previous?.logged), ...pendingField(previous?.pending), ...toldField(previous?.told), ...wokenField(previous?.woken) };
}

/** How long a started act holds its session: past any close's or reopen's run, so one that died is started again. */
export const IDLE_ACT_HOLD_MS = 5 * MS_PER_MINUTE;

/** Whether the step still asks for the act: a reopen held back by another's or by the host's room still wants one. */
function stillAsks(step: PassStep, act: IdleAct): boolean {
  return act === 'close' ? step.kind === 'close' : step.kind === 'reopen' || step.kind === 'later';
}

/**
 * The pending acts this pass keeps: each whose session's step still asks for it, started under `IDLE_ACT_HOLD_MS`
 * ago. One done (the session closed or running), one its act weighed again and kept, and one gone from the roster
 * let go; so does one too old, or started after now (the clock went back), so a dead act is started again.
 */
export function heldActs(pending: Readonly<Record<string, PendingAct>> | undefined, steps: readonly PassStep[], now: number): Record<string, PendingAct> {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  return Object.fromEntries(
    Object.entries(pending ?? {}).filter(([id, mark]) => {
      const step = stepById.get(id);
      return step !== undefined && stillAsks(step, mark.act) && now >= mark.at && now - mark.at < IDLE_ACT_HOLD_MS;
    }),
  );
}

/** An act the pass starts, on its session, in the folder the pass read it in. */
export interface ActToStart {
  readonly act: IdleAct;
  readonly id: string;
  readonly project: string;
}

/** The acts the pass starts now: each a close or a reopen step asks for, but none while one is pending on its session. */
export function actsToStart(steps: readonly PassStep[], held: Readonly<Record<string, PendingAct>>): ActToStart[] {
  return steps.flatMap((step) => {
    if ((step.kind !== 'close' && step.kind !== 'reopen') || Object.hasOwn(held, step.id)) {
      return [];
    }
    return [{ act: step.kind, id: step.id, project: step.project }];
  });
}

/** One logged step: its kind, its session, and its line as `teamrig sessions --pass` prints it. */
export interface LoggedStep {
  readonly kind: PassKind;
  readonly id: string;
  readonly line: string;
}

/**
 * What an act the pass started came to: done, kept (weighed again, the session no longer closes or reopens, or the
 * host has no room for its reopen) or failed.
 */
export type ActOutcome = 'done' | 'kept' | 'failed';

/** An act a pass started on one session: its outcome and line, and the host's commit charge before and after it. */
export interface IdleActRecord {
  readonly kind: 'act';
  readonly at: number;
  readonly mode: IdleMode;
  readonly act: IdleAct;
  readonly id: string;
  readonly outcome: ActOutcome;
  readonly line: string;
  readonly before: CommitCharge | undefined;
  readonly after: CommitCharge | undefined;
}

/**
 * A reopened tab no hook started in, as a pass told of it: its line, and why the line was not posted (in dry-run,
 * which posts none, undefined too).
 */
export interface HooklessRecord {
  readonly kind: 'hookless';
  readonly at: number;
  readonly mode: IdleMode;
  readonly id: string;
  readonly line: string;
  readonly problem: string | undefined;
}

/**
 * A quiet session a pass woke for work it can start: the line it posted it, and why that line was not posted (in
 * dry-run, which posts none, undefined too).
 */
export interface IdleWakeRecord {
  readonly kind: 'wake';
  readonly at: number;
  readonly mode: IdleMode;
  readonly id: string;
  readonly line: string;
  readonly problem: string | undefined;
}

/**
 * A pass that changed a session's step, with the host's commit charge then (undefined: unknown), a new failure of
 * one, an act, a hookless reopen, or a wake.
 */
export type IdlePassRecord =
  | { readonly kind: 'pass'; readonly at: number; readonly mode: IdleMode; readonly commit: CommitCharge | undefined; readonly steps: readonly LoggedStep[] }
  | { readonly kind: 'failed'; readonly at: number; readonly mode: IdleMode; readonly error: string }
  | IdleActRecord
  | HooklessRecord
  | IdleWakeRecord;

/** The commit charge under `key`; nothing where it is unknown. */
function commitField(key: string, commit: CommitCharge | undefined): JsonRecord {
  return commit === undefined ? {} : { [key]: { usedMb: commit.usedMb, limitMb: commit.limitMb } };
}

export function formatIdlePassRecord(record: IdlePassRecord): string {
  const base = { [VERSION_FIELD]: IDLE_PASS_LOG_FORMAT, at: new Date(record.at).toISOString(), kind: record.kind, mode: record.mode };
  switch (record.kind) {
    case 'failed':
      return toJsonlLine({ ...base, error: record.error });
    case 'act':
      return toJsonlLine({ ...base, act: record.act, id: record.id, outcome: record.outcome, line: record.line, ...commitField('before', record.before), ...commitField('after', record.after) });
    case 'hookless':
    case 'wake':
      return toJsonlLine({ ...base, id: record.id, line: record.line, ...(record.problem === undefined ? {} : { problem: record.problem }) });
    case 'pass':
      return toJsonlLine({ ...base, ...commitField('commit', record.commit), steps: record.steps.map((step) => ({ kind: step.kind, id: step.id, line: step.line })) });
  }
}
