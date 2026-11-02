import type { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { noRoomText } from '../sessions/headroom.ts';
import { reopenVerdict, type ReopenInput, type ReopenVerdict } from '../sessions/idle.ts';
import { closedOf, SessionLog, type SessionLogRecord } from '../sessions/log.ts';
import { urgentLinesText } from '../wake/asks.ts';
import { byUrgency, COLD_WAKE_W, effectivePriority, HELD_PRIORITY, wakeRestOf, type WakeRest } from '../wake/decide.ts';
import { budgetFactsOf } from './commands/hook-budget.ts';
import { headroomOf } from './headroom.ts';
import { closableText, idleFactsOf, idleVerdictOf, type Closable, type IdleFacts, type IdleVerdict } from './idle-check.ts';
import type { Kit } from './kit.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';
import { installStateOf, settleWaitText } from './settled-install.ts';

/** A session the budget neither holds nor puts in quiet hours. */
const AWAKE: WakeRest = { held: false, quiet: false };

/** Why a closed session reopens: urgent lines posted to it, work handed to it since its close, or the day's start. */
type Reopening = Exclude<ReopenVerdict, { readonly kind: 'stay' }>;

/** What a pass does with one session of the team; a close or a reopen in the folder the pass read it in (`project`). */
export type PassStep =
  | { readonly kind: 'close'; readonly id: string; readonly closable: Closable; readonly project: string }
  | { readonly kind: 'keep'; readonly id: string; readonly why: string }
  | { readonly kind: 'reopen'; readonly id: string; readonly reopening: Reopening; readonly project: string }
  /**
   * A reopen this pass does not make: another took its one reopen, its folder is refused, the plugin install is not
   * settled, or the host has no room.
   */
  | { readonly kind: 'later'; readonly id: string; readonly reopening: Reopening; readonly why: string }
  | { readonly kind: 'closed'; readonly id: string }
  /** Not running, and not closed by teamrig: the pass leaves it. */
  | { readonly kind: 'away'; readonly id: string };

/** The project folder a session's Claude Code runs in; it refuses one that is no folder. */
export type SessionFolderOf = (id: string) => Promise<string>;

/** A closed session the wake check would wake, its most urgent task and its folder, before the pass picks which reopens. */
export interface ReopenWish {
  readonly kind: 'wish';
  readonly id: string;
  readonly reopening: Reopening;
  /** Undefined only for a reopen for urgent lines, which needs no task. */
  readonly top: Task | undefined;
  readonly project: string;
}

/** A session's folder, or why it is refused (`projectOf` in src/cli/commands/setup.ts). */
type SessionFolder = { readonly kind: 'folder'; readonly project: string } | { readonly kind: 'refused'; readonly why: string };

/** The session's folder; one refused holds only its own session, so the pass goes on for the rest. */
async function folderOrRefusalOf(folderOf: SessionFolderOf, id: string): Promise<SessionFolder> {
  try {
    return { kind: 'folder', project: await folderOf(id) };
  } catch (error) {
    if (error instanceof RefusedError) {
      return { kind: 'refused', why: error.message };
    }
    throw error;
  }
}

/** The pass's pick: urgent lines first, the oldest first, then the most urgent top task. */
function byReopenOrder(a: ReopenWish, b: ReopenWish): number {
  if (a.reopening.kind === 'asked') {
    return b.reopening.kind === 'asked' ? a.reopening.at - b.reopening.at : -1;
  }
  if (b.reopening.kind === 'asked') {
    return 1;
  }
  return a.top === undefined || b.top === undefined ? 0 : byUrgency(a.top, b.top);
}

/** One session judged alone: what it does, or, for one it would reopen, its wish, before the pass picks one reopen. */
export type JudgedStep = Exclude<PassStep, { readonly kind: 'reopen' }> | ReopenWish;

/**
 * The session's rest and the least urgent priority up to `configured` that wakes it now, as `hook wake-check` weighs
 * them: a session its budget holds or a short day pauses wakes, and so stays open, for p0 only, one in the budget's
 * quiet hours for p1 and p0 (`effectivePriority`). The wake it weighs is counted cold: a closed session reopens cold, and a running one the
 * pass would close has been quiet `open.headroom.closeIdleMinutes`.
 */
async function wakeWeightOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, id: string, configured: number): Promise<{ readonly rest: WakeRest; readonly maxPriority: number }> {
  const rest = config.budget.enabled ? wakeRestOf(await budgetFactsOf(runtime, { kit, config, roster, id }, undefined), config.budget.quietHours, runtime.clock.now(), COLD_WAKE_W) : AWAKE;
  return { rest, maxPriority: effectivePriority(configured, rest) };
}

/**
 * True when the session has an unfinished task past p0 within `configured`: the only tasks a rest (which caps that
 * priority at p0 or p1) can take out of a running session's verdict.
 */
function hasWorkARestCuts(tasks: ReadonlyMap<string, Task>, id: string, configured: number): boolean {
  return [...tasks.values()].some((task) => task.owner === id && task.priority > HELD_PRIORITY && task.priority <= configured && task.status !== 'done' && task.status !== 'dropped');
}

/**
 * The least urgent priority up to `configured` whose work keeps the running session `id` open, weighed as `hook
 * wake-check` weighs it ({@link wakeWeightOf}). Its budget takes thousands of file reads, so it counts as awake
 * unless its rest can change the verdict: when it has work a rest cuts ({@link hasWorkARestCuts}).
 */
export async function restCappedPriority(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, tasks: ReadonlyMap<string, Task>, id: string, configured: number): Promise<number> {
  return hasWorkARestCuts(tasks, id, configured) ? (await wakeWeightOf(runtime, kit, config, roster, id, configured)).maxPriority : configured;
}

/** Whether the running session `id` closes, its work weighed as `hook wake-check` weighs it: work that would wake it keeps it open. */
export async function runningVerdictOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, facts: IdleFacts, id: string, project: string): Promise<IdleVerdict> {
  const maxPriority = await restCappedPriority(runtime, kit, config, roster, facts.tasks, id, config.wake.priority);
  return idleVerdictOf(runtime, config, roster, facts, id, { maxPriority, project });
}

/**
 * One session's step, or its wish to reopen: a running one by {@link runningVerdictOf}, a closed one counted awake
 * unless it would reopen awake for work (a rest only holds such a reopen back, never one for urgent lines), since its
 * budget takes thousands of file reads. One whose folder is refused stays as it is, its refusal the why: kept open, or
 * its reopen left for later.
 */
export async function judgeSession(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, facts: IdleFacts, id: string, folderOf: SessionFolderOf, closes: readonly SessionLogRecord[]): Promise<JudgedStep> {
  const { tasks, elsewhere, now, zone } = facts;
  if (facts.places.find((place) => place.id === id)?.state === 'running') {
    const folder = await folderOrRefusalOf(folderOf, id);
    if (folder.kind === 'refused') {
      return { kind: 'keep', id, why: `${roster.nameOf(id) ?? id} (session ${id}): ${folder.why}` };
    }
    const verdict = await runningVerdictOf(runtime, kit, config, roster, facts, id, folder.project);
    return verdict.kind === 'close' ? { kind: 'close', id, closable: verdict.closable, project: folder.project } : { kind: 'keep', id, why: verdict.why };
  }
  const awake = { rest: AWAKE, maxPriority: config.wake.priority };
  const closed = closedOf(closes, id);
  if (closed === undefined) {
    return { kind: 'away', id };
  }
  const asks = facts.asks.get(id) ?? [];
  const input: ReopenInput = { tasks, elsewhere, session: id, asks, closedAt: Date.parse(closed.at), ...awake, dayStartUtc: config.wake.dayStartUtc, now, zone };
  const asAwake = reopenVerdict(input);
  if (asAwake.kind === 'asked') {
    return wishOf(folderOf, id, asAwake, undefined);
  }
  const reopening = asAwake.kind === 'stay' ? asAwake : reopenVerdict({ ...input, ...(await wakeWeightOf(runtime, kit, config, roster, id, config.wake.priority)) });
  // Never asked here: a session with asks reopened for them above.
  if (reopening.kind === 'stay' || reopening.kind === 'asked') {
    return { kind: 'closed', id };
  }
  const [top] = reopening.tasks;
  return top === undefined ? { kind: 'closed', id } : wishOf(folderOf, id, reopening, top);
}

/** The closed session's wish to reopen in its folder, or, its folder refused, its reopen left for later. */
async function wishOf(folderOf: SessionFolderOf, id: string, reopening: Reopening, top: Task | undefined): Promise<ReopenWish | Extract<PassStep, { readonly kind: 'later' }>> {
  const folder = await folderOrRefusalOf(folderOf, id);
  return folder.kind === 'refused' ? { kind: 'later', id, reopening, why: folder.why } : { kind: 'wish', id, reopening, top, project: folder.project };
}

/**
 * What one pass over the team's sessions does, in the roster's order, changing nothing (T1100): each running session
 * closes when `idleVerdictOf` finds it idle, else stays; each one teamrig closed reopens when the wake check would wake
 * it. One reopen a pass, urgent lines first, the oldest first, then the most urgent top task, and only on a settled
 * plugin install for its folder with room on the host, both read fresh (`reopenHoldOf`); the rest wait for the next
 * pass, so reopens never outrun what the host can hold. A running session's transcript is read in the folder
 * `folderOf` names for it when its record names none, and each close and reopen acts in that folder; a session whose
 * folder is refused holds only itself (`judgeSession`).
 */
export async function idlePassOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, folderOf: SessionFolderOf): Promise<readonly PassStep[]> {
  const facts = await idleFactsOf(runtime, kit, config, roster);
  const closes = (await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records;
  const judged: JudgedStep[] = [];
  for (const id of roster.ids) {
    judged.push(await judgeSession(runtime, kit, config, roster, facts, id, folderOf, closes));
  }
  const [first] = judged.filter((step): step is ReopenWish => step.kind === 'wish').sort(byReopenOrder);
  const hold = first === undefined ? undefined : await reopenHoldOf(runtime, kit, config, roster, first.project, first.id);
  return judged.map((step): PassStep => {
    if (step.kind !== 'wish') {
      return step;
    }
    const { id, reopening, project } = step;
    if (first !== undefined && id !== first.id) {
      return { kind: 'later', id, reopening, why: `${roster.nameOf(first.id) ?? first.id} reopens first, one a pass` };
    }
    return hold === undefined ? { kind: 'reopen', id, reopening, project } : { kind: 'later', id, reopening, why: hold };
  });
}

/**
 * Why the pass's one reopen, of `id`, waits for a later pass; undefined when it goes. A tab opened while an install
 * is copied runs without teamrig's hooks, so an unsettled install holds it first (`installStateOf`, the host's room
 * then unread), else a host without room for it.
 */
async function reopenHoldOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, project: string, id: string): Promise<string | undefined> {
  const install = await installStateOf(runtime, project);
  if (install.kind === 'unsettled') {
    return settleWaitText(install.why);
  }
  const room = await headroomOf(runtime, kit.paths, config, roster.ids);
  return room.short.length === 0 ? undefined : noRoomText(`reopen ${roster.nameOf(id) ?? id}`, room);
}

function idsText(tasks: readonly Task[]): string {
  return tasks.map((task) => task.id).join(', ');
}

/** Why a closed session reopens, as the pass's lines say it. */
export function reopeningText(reopening: Reopening, zone: TimeZone): string {
  switch (reopening.kind) {
    case 'asked':
      return urgentLinesText(reopening.asks);
    case 'handed':
      return `work handed to it since its close: ${idsText(reopening.tasks)}`;
    case 'day-start':
      return `the day's start at ${zone.clock(new Date(reopening.at))}, with work it can start: ${idsText(reopening.tasks)}`;
  }
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
