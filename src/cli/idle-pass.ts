import type { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { noRoomText } from '../sessions/headroom.ts';
import { reopenVerdict, type ReopenInput, type ReopenVerdict } from '../sessions/idle.ts';
import { closedOf, SessionLog, type SessionLogRecord } from '../sessions/log.ts';
import { byUrgency, effectivePriority, URGENT_PRIORITY, wakeRestOf, type WakeRest } from '../wake/decide.ts';
import { budgetFactsOf } from './commands/hook-budget.ts';
import { headroomOf } from './headroom.ts';
import { closableText, idleFactsOf, idleVerdictOf, type Closable, type IdleFacts } from './idle-check.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/** A session the budget neither holds nor puts in quiet hours. */
const AWAKE: WakeRest = { held: false, quiet: false };

/** Why a closed session reopens: work handed to it since its close, or the day's start. */
type Reopening = Exclude<ReopenVerdict, { readonly kind: 'stay' }>;

/** What a pass does with one session of the team. */
export type PassStep =
  | { readonly kind: 'close'; readonly id: string; readonly closable: Closable }
  | { readonly kind: 'keep'; readonly id: string; readonly why: string }
  | { readonly kind: 'reopen'; readonly id: string; readonly reopening: Reopening }
  /** A reopen this pass does not make: another took its one reopen, or the host has no room. */
  | { readonly kind: 'later'; readonly id: string; readonly reopening: Reopening; readonly why: string }
  | { readonly kind: 'closed'; readonly id: string }
  /** Not running, and not closed by teamrig: the pass leaves it. */
  | { readonly kind: 'away'; readonly id: string };

/** The project folder a session's Claude Code runs in; it refuses one that is no folder. */
export type SessionFolderOf = (id: string) => Promise<string>;

/** A closed session the wake check would wake, and its most urgent task, before the pass picks which reopens. */
interface ReopenWish {
  readonly kind: 'wish';
  readonly id: string;
  readonly reopening: Reopening;
  readonly top: Task;
}

/**
 * The session's rest and the least urgent priority that wakes it now, as `hook wake-check` weighs them: a session
 * its budget holds or in the budget's quiet hours wakes, and so stays open, for p1 only.
 */
async function wakeWeightOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, id: string): Promise<{ readonly rest: WakeRest; readonly maxPriority: number }> {
  const rest = config.budget.enabled ? wakeRestOf(await budgetFactsOf(runtime, { kit, config, roster, id }, undefined), config.budget.quietHours, runtime.clock.now()) : AWAKE;
  return { rest, maxPriority: effectivePriority(config.wake.priority, rest) };
}

/**
 * True when the session has an unfinished task past p1 within the configured wake priority: the only tasks a rest
 * (which caps that priority at p1) takes out of a running session's verdict.
 */
function hasWorkPastUrgent(tasks: ReadonlyMap<string, Task>, id: string, configured: number): boolean {
  return [...tasks.values()].some((task) => task.owner === id && task.priority > URGENT_PRIORITY && task.priority <= configured && task.status !== 'done' && task.status !== 'dropped');
}

/**
 * One session's step, or its wish to reopen. Its budget takes thousands of file reads, so a session counts as awake
 * unless its rest can change the step: a running one with work past p1 ({@link hasWorkPastUrgent}), a closed one that
 * would reopen awake (a rest only holds a reopen back).
 */
async function judge(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, facts: IdleFacts, id: string, folderOf: SessionFolderOf, closes: readonly SessionLogRecord[]): Promise<PassStep | ReopenWish> {
  const { tasks, now, zone } = facts;
  const awake = { rest: AWAKE, maxPriority: config.wake.priority };
  if (facts.places.find((place) => place.id === id)?.state === 'running') {
    const { maxPriority } = hasWorkPastUrgent(tasks, id, config.wake.priority) ? await wakeWeightOf(runtime, kit, config, roster, id) : awake;
    const verdict = await idleVerdictOf(runtime, config, roster, facts, id, { maxPriority, project: await folderOf(id) });
    return verdict.kind === 'close' ? { kind: 'close', id, closable: verdict.closable } : { kind: 'keep', id, why: verdict.why };
  }
  const closed = closedOf(closes, id);
  if (closed === undefined) {
    return { kind: 'away', id };
  }
  const input: ReopenInput = { tasks, session: id, closedAt: Date.parse(closed.at), ...awake, dayStartUtc: config.wake.dayStartUtc, now, zone };
  const asAwake = reopenVerdict(input);
  const reopening = asAwake.kind === 'stay' ? asAwake : reopenVerdict({ ...input, ...(await wakeWeightOf(runtime, kit, config, roster, id)) });
  if (reopening.kind === 'stay') {
    return { kind: 'closed', id };
  }
  const [top] = reopening.tasks;
  return top === undefined ? { kind: 'closed', id } : { kind: 'wish', id, reopening, top };
}

/**
 * What one pass over the team's sessions does, in the roster's order, changing nothing (T1100): each running session
 * closes when `idleVerdictOf` finds it idle, else stays; each one teamrig closed reopens when the wake check would wake
 * it. One reopen a pass, the most urgent top task first, and only with room on the host, read fresh; the rest wait for
 * the next pass, so reopens never outrun what the host can hold. A running session's transcript is read in the
 * folder `folderOf` names for it when its record names none.
 */
export async function idlePassOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, folderOf: SessionFolderOf): Promise<readonly PassStep[]> {
  const facts = await idleFactsOf(runtime, kit, config, roster);
  const closes = (await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records;
  const judged: (PassStep | ReopenWish)[] = [];
  for (const id of roster.ids) {
    judged.push(await judge(runtime, kit, config, roster, facts, id, folderOf, closes));
  }
  const [first] = judged.filter((step): step is ReopenWish => step.kind === 'wish').sort((a, b) => byUrgency(a.top, b.top));
  const room = first === undefined ? undefined : await headroomOf(runtime, kit.paths, config, roster.ids);
  return judged.map((step): PassStep => {
    if (step.kind !== 'wish') {
      return step;
    }
    const { id, reopening } = step;
    if (first !== undefined && id !== first.id) {
      return { kind: 'later', id, reopening, why: `${roster.nameOf(first.id) ?? first.id} reopens first, one a pass` };
    }
    return room === undefined || room.short.length === 0 ? { kind: 'reopen', id, reopening } : { kind: 'later', id, reopening, why: noRoomText(`reopen ${roster.nameOf(id) ?? id}`, room) };
  });
}

function idsText(tasks: readonly Task[]): string {
  return tasks.map((task) => task.id).join(', ');
}

function reopeningText(reopening: Reopening, zone: TimeZone): string {
  return reopening.kind === 'handed'
    ? `work handed to it since its close: ${idsText(reopening.tasks)}`
    : `the day's start at ${zone.clock(new Date(reopening.at))}, with work it can start: ${idsText(reopening.tasks)}`;
}

/** The step's line, as `teamrig sessions --pass` prints it. */
export function passLineOf(step: PassStep, roster: Roster, zone: TimeZone): string {
  const label = `${roster.nameOf(step.id) ?? step.id} (session ${step.id})`;
  switch (step.kind) {
    case 'close':
      return `CLOSE ${label}: ${closableText(step.closable)}`;
    case 'keep':
      return `KEEP ${step.why}`;
    case 'reopen':
      return `REOPEN ${label}: ${reopeningText(step.reopening, zone)}`;
    case 'later':
      return `LATER ${label}: ${reopeningText(step.reopening, zone)}; ${step.why}`;
    case 'closed':
      return `CLOSED ${label}: nothing it can start`;
    case 'away':
      return `AWAY ${label}: not running, and ${KIT_NAME} did not close it`;
  }
}

/** The pass's total line. */
export function passTotalOf(steps: readonly PassStep[]): string {
  const count = (kind: PassStep['kind']): number => steps.filter((step) => step.kind === kind).length;
  return `PASS ${steps.length} session(s): ${count('close')} to close, ${count('reopen')} to reopen, ${count('later')} to reopen later, ${count('keep')} kept open, ${count('closed')} closed, ${count('away')} away; nothing changed`;
}
