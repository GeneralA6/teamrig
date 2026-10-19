import { activeBurst } from '../../budget/burst.ts';
import { BurstLog } from '../../budget/burst-log.ts';
import { claudeProjectsDir, lastWriteOf } from '../../budget/discover.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { isRecord, stringField } from '../../core/guards.ts';
import { FileLock, LockBusyError } from '../../core/lock.ts';
import { MeetingStore, phaseOf } from '../../meeting/state.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import type { Task } from '../../register/fold.ts';
import { dayStartPrompt, dayStartToast, decideDayStart, dueMoments, nextDayStartAt, startableTasks, type DayMoment, type DayStartVerdict } from '../../wake/day-start.ts';
import { decideWake, effectivePriority, URGENT_PRIORITY, wakeCost, wakePrompt, wakeRestOf, wakeToast, type WakeState } from '../../wake/decide.ts';
import { logWake, WakeStore } from '../../wake/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';
import { budgetFactsOf } from './hook-budget.ts';
import { parseJson, sessionTeam, teamSessionOf } from './hook-input.ts';

/**
 * What `hook wake-check` answers the plugin's mod, one JSON line: submit `text` as a prompt and show `toast`; or
 * check again once the register file `watch` changes or at `recheckAt` (epoch ms; null: no time set); or nothing to
 * wake for in this tab (`why`), which the mod checks again later all the same, since the config may change.
 */
export type WakeAnswer =
  | { readonly kind: 'wake'; readonly ids: readonly string[]; readonly text: string; readonly toast: string }
  | { readonly kind: 'wait'; readonly watch: string; readonly recheckAt: number | null }
  | { readonly kind: 'off'; readonly why: string };

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

function answer(runtime: CliRuntime, value: WakeAnswer): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

/** Where the check stands: the team session the tab is, and the kit it is in. */
type Scope =
  | { readonly kind: 'found'; readonly kit: Kit; readonly config: KitConfig; readonly roster: Roster; readonly id: string; readonly tab: string }
  | { readonly kind: 'off'; readonly why: string };

async function scopeOf(runtime: CliRuntime, payload: unknown, needsWake: boolean): Promise<Scope> {
  const tab = sessionIdOf(payload);
  if (tab === null) {
    return { kind: 'off', why: 'no session id' };
  }
  const found = await sessionTeam(payload, runtime);
  if (found.kind !== 'team') {
    return { kind: 'off', why: 'not in a team' };
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return { kind: 'off', why: 'the team config does not load' };
  }
  const { config } = kit.load;
  if (needsWake && !config.wake.enabled) {
    return { kind: 'off', why: 'wake.enabled is false' };
  }
  const roster = await rosterOf(runtime, kit, config);
  const id = await teamSessionOf(runtime, kit, roster, tab);
  return id === undefined ? { kind: 'off', why: 'this tab is not a team session' } : { kind: 'found', kit, config, roster, id, tab };
}

/**
 * The least urgent priority that wakes the session now. Waking for p1 alone needs no budget read; for more, a
 * session past its daily budget or in the budget's quiet hours (unless its lift exempts it) still wakes for p1 only.
 */
async function maxPriorityOf(runtime: CliRuntime, scope: Extract<Scope, { kind: 'found' }>): Promise<number> {
  const { config } = scope;
  const configured = config.wake.priority;
  if (configured <= URGENT_PRIORITY || !config.budget.enabled) {
    return configured;
  }
  const facts = await budgetFactsOf(runtime, { kit: scope.kit, config, roster: scope.roster, id: scope.id }, undefined);
  return effectivePriority(configured, wakeRestOf(facts, config.budget.quietHours, runtime.clock.now()));
}

/**
 * While the owner's daily meeting is open, the lead is not woken: the meeting holds every message to the lead but a
 * CRITICAL one (src/meeting/quiet.ts), and a wake would start a turn in the middle of it. The work handed meanwhile
 * stays new, so it wakes the lead at the first check after the meeting.
 */
async function meetingHoldsWake(runtime: CliRuntime, scope: Extract<Scope, { kind: 'found' }>): Promise<boolean> {
  if (scope.roster.holderOf('lead') !== scope.id) {
    return false;
  }
  const meeting = await new MeetingStore(runtime.files, scope.kit.paths.meeting).read();
  return phaseOf(meeting, runtime.clock.now()).kind === 'open';
}

/**
 * What the check decided under the lock: a wake for work handed to the session, one for the day's moments (with
 * the tab's last turn it read), or when to check again (null: no time set).
 */
type CheckVerdict =
  | { readonly kind: 'handed'; readonly tasks: readonly Task[] }
  | { readonly kind: 'moments'; readonly moments: readonly DayMoment[]; readonly tasks: readonly Task[]; readonly lastTurnAt: number | undefined }
  | { readonly kind: 'wait'; readonly recheckAt: number | null };

/** The day's moments checked: the verdict, the state to keep, and the next day start (undefined: none set). */
interface MomentsCheck {
  readonly verdict: DayStartVerdict;
  readonly state: WakeState;
  readonly lastTurnAt: number | undefined;
  readonly next: number | undefined;
}

/** The earliest of the times given; null with none. */
function earliest(...times: readonly (number | undefined)[]): number | null {
  const set = times.filter((time): time is number => time !== undefined);
  return set.length === 0 ? null : Math.min(...set);
}

/**
 * The day's moments (src/wake/day-start.ts), checked when no handed work wakes the session and only with
 * `wake.dayStartUtc` set. The budget and the tab's last turn are read only once a moment is due and the session has
 * work it can start; a moments wake takes in any batch still pending, since it names all that work.
 */
async function momentsOf(runtime: CliRuntime, scope: Extract<Scope, { kind: 'found' }>, tasks: ReadonlyMap<string, Task>, state: WakeState, now: number): Promise<MomentsCheck> {
  const { config, kit, roster, id, tab } = scope;
  const { dayStartUtc } = config.wake;
  if (dayStartUtc === undefined) {
    return { verdict: { kind: 'none' }, state, lastTurnAt: undefined, next: undefined };
  }
  const next = nextDayStartAt(dayStartUtc, now);
  const none: MomentsCheck = { verdict: { kind: 'none' }, state, lastTurnAt: undefined, next };
  const startable = startableTasks(tasks, id, now);
  const logged = activeBurst((await new BurstLog(runtime.files, kit.paths.bursts).read()).records, now, undefined);
  const inBurst = logged?.sessions.includes(id) === true ? logged : undefined;
  if (startable.length === 0 || dueMoments(now, dayStartUtc, inBurst, state.settled).length === 0) {
    return none;
  }
  const facts = await budgetFactsOf(runtime, { kit, config, roster, id }, undefined);
  const lastTurnAt = await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), [tab]);
  const decision = decideDayStart({
    due: dueMoments(now, dayStartUtc, facts === undefined ? inBurst : facts.burst, state.settled),
    startable,
    lastTurnAt,
    rest: wakeRestOf(facts, config.budget.quietHours, now),
    now,
    lastWakeAt: state.lastWakeAt,
    minGapMs: config.wake.minGapMinutes * MINUTE_MS,
    settled: state.settled,
  });
  const woke = decision.verdict.kind === 'wake' ? { pending: undefined, lastWakeAt: now } : {};
  return { verdict: decision.verdict, state: { ...state, ...woke, settled: decision.settled }, lastTurnAt, next };
}

/** Decides under the session's wake lock, so two tabs of one session never wake it twice. */
async function decide(runtime: CliRuntime, scope: Extract<Scope, { kind: 'found' }>, store: WakeStore): Promise<CheckVerdict> {
  const { config, kit, id, tab } = scope;
  const { files, clock, sleep, pid } = runtime;
  const lock = new FileLock(store.lockOf(id), { ...config.lock, waitMs: 0 }, { files, clock, sleep, pid });
  return lock.run(async (): Promise<CheckVerdict> => {
    const { tasks } = (await teamRegister(runtime, kit.paths, config).snapshot()).state;
    const now = clock.now();
    const decision = decideWake({
      tasks,
      session: id,
      tab,
      now,
      maxPriority: await maxPriorityOf(runtime, scope),
      batchMs: config.wake.batchSeconds * SECOND_MS,
      minGapMs: config.wake.minGapMinutes * MINUTE_MS,
      previous: await store.read(id),
    });
    if (decision.verdict.kind === 'wake') {
      await store.write(id, decision.state);
      return { kind: 'handed', tasks: decision.verdict.tasks };
    }
    const day = await momentsOf(runtime, scope, tasks, decision.state, now);
    await store.write(id, day.state);
    if (day.verdict.kind === 'wake') {
      return { kind: 'moments', moments: day.verdict.moments, tasks: day.verdict.tasks, lastTurnAt: day.lastTurnAt };
    }
    const handedAt = decision.verdict.kind === 'later' ? decision.verdict.at : undefined;
    return { kind: 'wait', recheckAt: earliest(handedAt, day.verdict.kind === 'later' ? day.verdict.at : undefined, day.next) };
  });
}

/**
 * Run by the plugin's mod while its tab is idle at the prompt: whether new work handed to the tab's session should
 * wake it now (src/wake/decide.ts), else whether the day's start or a burst should (src/wake/day-start.ts). On a
 * wake it logs the wake and its cost to the team's wake log and answers the prompt to submit; a busy lock (another
 * tab of the session checking) answers a recheck now. The lead is not woken while the owner's daily meeting is open.
 */
export async function wakeCheck(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const scope = await scopeOf(runtime, parseJson(await runtime.readStdin()), true);
  if (scope.kind === 'off') {
    return answer(runtime, scope);
  }
  const { kit, config, id, tab } = scope;
  if (await meetingHoldsWake(runtime, scope)) {
    return answer(runtime, { kind: 'wait', watch: kit.paths.events, recheckAt: null });
  }
  const store = new WakeStore(runtime.files, kit.paths.wake);
  let verdict: CheckVerdict;
  try {
    verdict = await decide(runtime, scope, store);
  } catch (error) {
    if (error instanceof LockBusyError) {
      return answer(runtime, { kind: 'wait', watch: kit.paths.events, recheckAt: runtime.clock.now() });
    }
    throw error;
  }
  if (verdict.kind === 'wait') {
    return answer(runtime, { kind: 'wait', watch: kit.paths.events, recheckAt: verdict.recheckAt });
  }
  const now = runtime.clock.now();
  const last = verdict.kind === 'moments' ? verdict.lastTurnAt : await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), [tab]);
  const cost = wakeCost(last === undefined ? undefined : now - last, config.messages.coldAfterMinutes, config.budget.weeklyLimitW);
  const ids = verdict.tasks.map((task) => task.id);
  if (verdict.kind === 'handed') {
    await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost });
    return answer(runtime, { kind: 'wake', ids, text: wakePrompt(id, verdict.tasks, cost), toast: wakeToast(verdict.tasks, cost) });
  }
  const moments = verdict.moments.map((moment) => moment.kind);
  await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost, moments });
  const text = dayStartPrompt(id, scope.roster.nameOf(id) ?? id, verdict.moments, verdict.tasks, cost);
  return answer(runtime, { kind: 'wake', ids, text, toast: dayStartToast(verdict.moments, verdict.tasks, cost) });
}

/** Run by the mod when Claude Code dropped a wake it submitted (a prompt hook refused it): logs it with the reason. */
export async function wakeDropped(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const scope = await scopeOf(runtime, payload, false);
  if (scope.kind === 'off') {
    return EXIT.ok;
  }
  const reason = (isRecord(payload) ? stringField(payload, 'reason') : undefined) ?? 'no reason given';
  await logWake(runtime.files, scope.kit.paths.wakeLog, { kind: 'dropped', at: runtime.clock.now(), session: scope.id, tab: scope.tab, reason });
  return EXIT.ok;
}
