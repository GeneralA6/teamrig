import type { IdleMode } from '../config/types.ts';
import type { CommitCharge } from '../coordinator/memory.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import type { PassStep } from './idle-pass.ts';

/**
 * The idle pass as the wake check runs it (T1100), kept pure: at most once every `IDLE_PASS_EVERY_MS` across the
 * team, and its log keeps only what changed, so a day of quiet passes writes nothing to it. The state file keeps the
 * last pass's time and each session's step kind then; a failed pass keeps the kinds and its error, logged once until
 * the error changes.
 */

/** The format of the pass's state file this code reads and writes; a file in another format reads as no pass yet. */
export const IDLE_PASS_STATE_FORMAT = 1;

/** The format of the pass log's records. */
export const IDLE_PASS_LOG_FORMAT = 1;

/** How often the wake checks run the pass, across the team. */
export const IDLE_PASS_EVERY_MS = MS_PER_MINUTE;

export type PassKind = PassStep['kind'];

const PASS_KINDS: Readonly<Record<PassKind, true>> = { close: true, keep: true, reopen: true, later: true, closed: true, away: true };

function isPassKind(value: unknown): value is PassKind {
  return typeof value === 'string' && Object.hasOwn(PASS_KINDS, value);
}

/** The team's pass: when it last ran, each session's step kind at the last pass that ran through, and the error of a failing one. */
export interface IdlePassState {
  readonly at: number;
  readonly kinds: Readonly<Record<string, PassKind>>;
  readonly failed?: string;
}

/** The state file's content; undefined when it is damaged or from another format, which reads as no pass yet. */
export function parseIdlePassState(text: string): IdlePassState | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== IDLE_PASS_STATE_FORMAT) {
    return undefined;
  }
  const { at, kinds, failed } = record;
  if (typeof at !== 'number' || !Number.isFinite(at) || !isRecord(kinds) || (failed !== undefined && typeof failed !== 'string')) {
    return undefined;
  }
  const entries = Object.entries(kinds);
  const known = entries.filter((entry): entry is [string, PassKind] => isPassKind(entry[1]));
  if (known.length !== entries.length) {
    return undefined;
  }
  return { at, kinds: Object.fromEntries(known), ...(failed === undefined ? {} : { failed }) };
}

export function formatIdlePassState(state: IdlePassState): string {
  return toJsonlLine({ [VERSION_FIELD]: IDLE_PASS_STATE_FORMAT, at: state.at, kinds: { ...state.kinds }, ...(state.failed === undefined ? {} : { failed: state.failed }) });
}

/** Whether a wake check runs the pass now: `IDLE_PASS_EVERY_MS` passed since the last, or the clock went back past it. */
export function isPassDue(state: IdlePassState | undefined, now: number): boolean {
  return state === undefined || now < state.at || now - state.at >= IDLE_PASS_EVERY_MS;
}

/** How long the pass may go without running before `check` warns the lead (FLEET-STALE): fifteen missed passes. */
export const IDLE_PASS_STALE_MS = 15 * MS_PER_MINUTE;

/** Why a pass that is on needs the lead: it has not run for `IDLE_PASS_STALE_MS` (`at` undefined: never), or its last run failed. */
export type IdlePassTrouble = { readonly kind: 'stale'; readonly at: number | undefined } | { readonly kind: 'failed'; readonly at: number; readonly error: string };

/**
 * The trouble of a pass that is on; none while it ran within `IDLE_PASS_STALE_MS` and its last run went through. A
 * failed pass still advances `at`, so its age alone misses it; a clock gone back reads as a pass just run.
 */
export function idlePassTrouble(state: IdlePassState | undefined, now: number): IdlePassTrouble | undefined {
  if (state === undefined || now - state.at > IDLE_PASS_STALE_MS) {
    return { kind: 'stale', at: state?.at };
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
  const ran = trouble.at === undefined ? 'has not run yet' : `last ran ${minutesAgo(trouble.at, now)}`;
  return `${head} ${ran}: an idle tab's hook wake-check runs it once a minute, so check wake.enabled and that the tabs' teamrig hooks run`;
}

/** The steps whose kind changed since the last pass that ran through; every step at the first. */
export function changedSteps(previous: IdlePassState | undefined, steps: readonly PassStep[]): PassStep[] {
  return steps.filter((step) => previous?.kinds[step.id] !== step.kind);
}

/** The state after a pass that ran through. */
export function passedState(now: number, steps: readonly PassStep[]): IdlePassState {
  return { at: now, kinds: Object.fromEntries(steps.map((step): [string, PassKind] => [step.id, step.kind])) };
}

/** The state after a failed pass: the kinds of the last pass that ran through, so the next one logs its changes since. */
export function failedState(previous: IdlePassState | undefined, now: number, error: string): IdlePassState {
  return { at: now, kinds: previous?.kinds ?? {}, failed: error };
}

/** One logged step: its kind, its session, and its line as `teamrig sessions --pass` prints it. */
export interface LoggedStep {
  readonly kind: PassKind;
  readonly id: string;
  readonly line: string;
}

/** What an act the pass started came to: done, kept (weighed again, the session no longer closes) or failed. */
export type ActOutcome = 'done' | 'kept' | 'failed';

/** An act a pass started on one session: its outcome and line, and the host's commit charge before and after it. */
export interface IdleActRecord {
  readonly kind: 'act';
  readonly at: number;
  readonly mode: IdleMode;
  readonly act: 'close';
  readonly id: string;
  readonly outcome: ActOutcome;
  readonly line: string;
  readonly before: CommitCharge | undefined;
  readonly after: CommitCharge | undefined;
}

/** A pass that changed a session's step, with the host's commit charge then (undefined: unknown), a new failure of one, or an act. */
export type IdlePassRecord =
  | { readonly kind: 'pass'; readonly at: number; readonly mode: IdleMode; readonly commit: CommitCharge | undefined; readonly steps: readonly LoggedStep[] }
  | { readonly kind: 'failed'; readonly at: number; readonly mode: IdleMode; readonly error: string }
  | IdleActRecord;

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
    case 'pass':
      return toJsonlLine({ ...base, ...commitField('commit', record.commit), steps: record.steps.map((step) => ({ kind: step.kind, id: step.id, line: step.line })) });
  }
}
