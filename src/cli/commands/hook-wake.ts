import { activeBurst } from '../../budget/burst.ts';
import { BurstLog } from '../../budget/burst-log.ts';
import { claudeProjectsDir, lastWriteOf } from '../../budget/discover.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { isRecord, stringField } from '../../core/guards.ts';
import { LockBusyError } from '../../core/lock.ts';
import { MeetingStore, phaseOf } from '../../meeting/state.ts';
import { restartMayAct } from '../../refresh/restart.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { sessionIdOf, unseenLinesOf } from '../../inbox/inbox.ts';
import { dayProbeClaimLine, dayProbePath } from '../../restore/day-probe.ts';
import { DayProbeStore } from '../../restore/day-probe-store.ts';
import { claudeCredentialsPath, LOGIN_LOCK, loginHoldsDayStart, loginMarkerPath, loginRetryLine, type LoginRetryWhy } from '../../restore/login.ts';
import { LoginStore } from '../../restore/login-store.ts';
import { apiRetryLine, claimApiRetry } from '../../restore/api-error.ts';
import { RestoreRegistry, restoreLogPath, restoreSessionsDir } from '../../restore/registry.ts';
import type { Task } from '../../register/fold.ts';
import { parkRulesOf } from '../../register/park.ts';
import type { TasksElsewhere } from '../../register/tree.ts';
import { askVerdictOf, asksFolderOf, asksNowOf, handedPrompt, handedToast, WakeAsks, type WakeAsk } from '../../wake/asks.ts';
import {
  dayStartPrompt,
  dayStartToast,
  decideDayStart,
  dueMoments,
  nextDayStartAt,
  startableTasks,
  type DayMoment,
  type DayStartInput,
  type DayStartLogin,
  type DayStartVerdict,
} from '../../wake/day-start.ts';
import { decideWake, effectivePriority, HELD_PRIORITY, wakeCost, wakeRestOf, type WakeDecision, type WakeInput, type WakeState, type WakeVerdict } from '../../wake/decide.ts';
import { apiRetryPrompt, apiRetryToast, type ApiRetryFacts } from '../../wake/api-retry.ts';
import { loginRetryPrompt, loginRetryToast } from '../../wake/login-retry.ts';
import { WakePrompts } from '../../wake/prompts.ts';
import { logWake, WakeStore } from '../../wake/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf, teamZone, type Kit } from '../kit.ts';
import { startDailyRollup } from '../rollup-start.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readTodayWPerPct } from '../stored-week.ts';
import { teamRegister } from '../team-register.ts';
import { budgetFactsOf } from './hook-budget.ts';
import { inboxDepsOf } from './inbox.ts';
import { runIdlePass } from './hook-idle-pass.ts';
import { parseJson, sessionTeam, teamSessionOf } from './hook-input.ts';
import { armParkedRestart, parkedHere, rearmDeadRestart, type RearmScope } from './hook-restart.ts';
import { fileLockOf } from '../file-locks.ts';

/**
 * What `hook wake-check` answers the plugin's mod, one JSON line: submit `text` as a prompt and show `toast`; or
 * check again once a file or folder in `watch` changes or at `recheckAt` (epoch ms; null: no time set); or nothing
 * to wake for in this tab (`why`), which the mod checks again later all the same, since the config may change.
 */
export type WakeAnswer =
  | { readonly kind: 'wake'; readonly ids: readonly string[]; readonly text: string; readonly toast: string }
  | { readonly kind: 'wait'; readonly watch: readonly string[]; readonly recheckAt: number | null }
  | { readonly kind: 'off'; readonly why: string };

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

function answer(runtime: CliRuntime, value: WakeAnswer): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

/**
 * Check again at `recheckAt`, or once the register changes (work handed) or the session's asks folder does (an urgent
 * or `inbox add --wake now` line posted), so a line is seen at the mod's next look, not RECHECK_MS later. It also
 * watches `also`: a tab stuck on an expired login, or whose day's moments wait for one, the login marker and the
 * credentials file, whose change is the next sign the login works; a tab waiting for another tab's day-start probe,
 * the probe's file (a release wakes it at once) and the login marker (the probe's turn failed).
 */
function waitAnswer(scope: Extract<WakeScope, { kind: 'found' }>, recheckAt: number | null, also: readonly string[] = []): WakeAnswer {
  return { kind: 'wait', watch: [scope.kit.paths.events, asksFolderOf(scope.kit.paths.wakeAsks, scope.id), ...also], recheckAt };
}

/**
 * Where a stuck tab's retry is claimed (src/restore/login.ts): the kit home's login marker in its store, the
 * credentials file whose change tests a renewed login, and the restore log each retry is written to; and where the
 * day-start probe is claimed (src/restore/day-probe.ts), in its store and file.
 */
interface LoginScope {
  readonly store: LoginStore;
  readonly marker: string;
  readonly credentials: string;
  readonly log: string;
  readonly probe: DayProbeStore;
  readonly probeFile: string;
}

function loginScopeOf(runtime: CliRuntime, kitHome: string): LoginScope {
  const marker = loginMarkerPath(kitHome);
  const probeFile = dayProbePath(kitHome);
  return {
    store: new LoginStore(runtime.files, marker, fileLockOf(runtime, `${marker}.lock`, LOGIN_LOCK)),
    marker,
    credentials: claudeCredentialsPath(runtime.env, runtime.userHome),
    log: restoreLogPath(kitHome),
    probe: new DayProbeStore(runtime.files, probeFile, fileLockOf(runtime, `${probeFile}.lock`, LOGIN_LOCK)),
    probeFile,
  };
}

/** The login as the day's moments see it before the probe: expired while the marker holds them (`loginHoldsDayStart`). */
async function dayLoginOf(runtime: CliRuntime, login: LoginScope): Promise<DayStartLogin> {
  return loginHoldsDayStart(await login.store.read(), await runtime.files.modifiedAt(login.credentials)) ? { kind: 'expired' } : { kind: 'ok' };
}

/** Where the check stands: the team session the tab is, and the kit it is in, found from the pointer `from`. */
export type WakeScope =
  | { readonly kind: 'found'; readonly kit: Kit; readonly config: KitConfig; readonly roster: Roster; readonly id: string; readonly tab: string; readonly from: string }
  | { readonly kind: 'off'; readonly why: string };

export async function wakeScopeOf(runtime: CliRuntime, payload: unknown, needsWake: boolean): Promise<WakeScope> {
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
  return id === undefined ? { kind: 'off', why: 'this tab is not a team session' } : { kind: 'found', kit, config, roster, id, tab, from: found.from };
}

/** The W of the turn a wake would start in a tab whose last turn was at `lastTurnAt` (undefined: unknown, counted cold). */
function wakeWOf(config: KitConfig, lastTurnAt: number | undefined, now: number): number {
  return wakeCost(lastTurnAt === undefined ? undefined : now - lastTurnAt, config.messages.coldAfterMinutes, undefined).w;
}

/** The ids of the tasks a verdict wakes the session for, now or later. */
function dueIdsOf(verdict: WakeVerdict): ReadonlySet<string> {
  return new Set(verdict.kind === 'wake' ? verdict.tasks.map((task) => task.id) : verdict.kind === 'later' ? verdict.ids : []);
}

/**
 * The wake decision at the least urgent priority that wakes the session now. It decides at `input.maxPriority`
 * (`wake.priority`) and reads the budget only when a task past p0 is due: a session its budget holds (past its
 * daily budget while the team has no room today, or paused by a short day: `wakeRestOf`) wakes for p0 only, one in
 * the budget's quiet hours (unless its lift
 * exempts it) for p1 and p0 (`effectivePriority`). Then it decides again at that priority, which wakes for a part of
 * what was due, and leaves the tasks the rest cut out of what the session knows, so they wake it once the rest ends.
 */
async function restCappedDecision(runtime: CliRuntime, scope: Extract<WakeScope, { kind: 'found' }>, input: WakeInput): Promise<WakeDecision> {
  const { config } = scope;
  const decision = decideWake(input);
  const due = dueIdsOf(decision.verdict);
  const dueTasks = [...input.tasks.values()].filter((task) => due.has(task.id));
  if (!config.budget.enabled || dueTasks.every((task) => task.priority <= HELD_PRIORITY)) {
    return decision;
  }
  const facts = await budgetFactsOf(runtime, { kit: scope.kit, config, roster: scope.roster, id: scope.id }, undefined);
  const lastTurnAt = await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), [scope.tab]);
  const rest = wakeRestOf(facts, config.budget.quietHours, input.now, wakeWOf(config, lastTurnAt, input.now));
  const maxPriority = effectivePriority(input.maxPriority, rest, config.budget.quietHours);
  const cut = new Set(dueTasks.filter((task) => task.priority > maxPriority).map((task) => task.id));
  if (cut.size === 0) {
    return decision;
  }
  const capped = decideWake({ ...input, maxPriority });
  return { verdict: capped.verdict, state: { ...capped.state, known: decision.state.known.filter((id) => !cut.has(id)) } };
}

/**
 * While the owner's daily meeting is open, the lead is not woken: the meeting holds every message to the lead but a
 * CRITICAL one (src/meeting/quiet.ts), and a wake would start a turn in the middle of it. The work handed meanwhile
 * stays new, so it wakes the lead at the first check after the meeting.
 */
async function meetingHoldsWake(runtime: CliRuntime, scope: Extract<WakeScope, { kind: 'found' }>): Promise<boolean> {
  if (scope.roster.holderOf('lead') !== scope.id) {
    return false;
  }
  const meeting = await new MeetingStore(runtime.files, scope.kit.paths.meeting).read();
  return phaseOf(meeting, runtime.clock.now()).kind === 'open';
}

/** How soon a check that a pending restart held looks again: the restart may end meanwhile without a register change. */
export const RESTART_RECHECK_MS = MINUTE_MS;

/**
 * How soon a tab waiting for another tab's day-start probe looks again, at the latest. It watches the probe's file, so
 * a release wakes it at once; this backs up a watch that missed the change.
 */
export const DAY_PROBE_RECHECK_MS = MINUTE_MS;

/**
 * While the session's automatic restart may still act (src/refresh/restart.ts), it is not woken: the wake's prompt
 * would cancel the restart as a typed one does (`hook prompt`), leaving the session with its handover written and no
 * fresh start. The work handed meanwhile stays new, so it wakes the fresh session. A restart whose runner died is
 * re-armed from this tab first (`rearmDeadRestart`), and holds the wake the same way once it is.
 */
async function restartHoldsWake(runtime: CliRuntime, store: RefreshStore, rearm: RearmScope): Promise<boolean> {
  const request = await store.restart(rearm.id);
  return restartMayAct(request, runtime.clock.now()) || (await rearmDeadRestart(runtime, store, rearm, request));
}

/**
 * What the check decided under the lock: a wake for work handed to the session or urgent lines posted for it (either
 * may be empty, not both), one for the day's moments (with the tab's last turn it read), a stuck tab's retry (`login`:
 * why, and when its turn failed), the retry of a turn that ended on a transient API error (`api`), the restart held
 * back for work armed in its place (`fresh`), or when to check again (null: no time set) and what else to watch for a
 * change (`waitAnswer`'s `also`).
 */
type CheckVerdict =
  | { readonly kind: 'handed'; readonly tasks: readonly Task[]; readonly asks: readonly WakeAsk[] }
  | { readonly kind: 'moments'; readonly moments: readonly DayMoment[]; readonly tasks: readonly Task[]; readonly lastTurnAt: number | undefined }
  | { readonly kind: 'login'; readonly why: LoginRetryWhy; readonly failAt: number }
  | { readonly kind: 'api'; readonly retry: ApiRetryFacts }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'wait'; readonly recheckAt: number | null; readonly watch: readonly string[] };

/**
 * The day's moments checked: the verdict, the state to keep, the next day start (undefined: none set), and the files
 * whose change may free moments the login holds (`waitAnswer`'s `also`).
 */
interface MomentsCheck {
  readonly verdict: DayStartVerdict;
  readonly state: WakeState;
  readonly lastTurnAt: number | undefined;
  readonly next: number | undefined;
  readonly watch: readonly string[];
}

/** The earliest of the times given; null with none. */
function earliest(...times: readonly (number | undefined)[]): number | null {
  const set = times.filter((time): time is number => time !== undefined);
  return set.length === 0 ? null : Math.min(...set);
}

/**
 * The day's moments (src/wake/day-start.ts), checked when no handed work wakes the session and only with
 * `wake.dayStartUtc` set. The budget, the tab's last turn and the login marker are read only once a moment is due and
 * the session has work it can start; a moments wake takes in any batch still pending, since it names all that work.
 *
 * A wake first gates on the day-start probe (src/restore/day-probe.ts), for the newest moment it wakes for: a claim
 * wakes the tab as the probe and logs it to the restore log; a hold keeps the open moments due, with no wake recorded,
 * until the probe's reply or its recheck. The claim comes before the restart check in `decide`: a restart started in
 * the wake's place is the probe all the same, since the fresh session's first answered turn releases it.
 */
async function momentsOf(
  runtime: CliRuntime,
  scope: Extract<WakeScope, { kind: 'found' }>,
  login: LoginScope,
  tasks: ReadonlyMap<string, Task>,
  elsewhere: TasksElsewhere,
  state: WakeState,
  now: number,
): Promise<MomentsCheck> {
  const { config, kit, roster, id, tab } = scope;
  const { dayStartUtc } = config.wake;
  if (dayStartUtc === undefined) {
    return { verdict: { kind: 'none' }, state, lastTurnAt: undefined, next: undefined, watch: [] };
  }
  // Ahead of the startable gate: a day with no work to wake for still closes a day of spend.
  await startDailyRollup(runtime, kit, id, dayStartUtc, now);
  const next = nextDayStartAt(dayStartUtc, now);
  const none: MomentsCheck = { verdict: { kind: 'none' }, state, lastTurnAt: undefined, next, watch: [] };
  const startable = startableTasks(tasks, elsewhere, id, now, teamZone(config, runtime), parkRulesOf(config));
  const logged = activeBurst((await new BurstLog(runtime.files, kit.paths.bursts).read()).records, now, undefined);
  const inBurst = logged?.sessions.includes(id) === true ? logged : undefined;
  if (startable.length === 0 || dueMoments(now, dayStartUtc, inBurst, state.settled).length === 0) {
    return none;
  }
  const facts = await budgetFactsOf(runtime, { kit, config, roster, id }, undefined);
  const lastTurnAt = await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), [tab]);
  const input: DayStartInput = {
    due: dueMoments(now, dayStartUtc, facts === undefined ? inBurst : facts.burst, state.settled),
    startable,
    lastTurnAt,
    rest: wakeRestOf(facts, config.budget.quietHours, now, wakeWOf(config, lastTurnAt, now)),
    now,
    lastWakeAt: state.lastWakeAt,
    minGapMs: config.wake.minGapMinutes * MINUTE_MS,
    settled: state.settled,
    login: await dayLoginOf(runtime, login),
  };
  const decision = decideDayStart(input);
  if (decision.verdict.kind !== 'wake') {
    const watch = input.login.kind === 'expired' ? [login.marker, login.credentials] : [];
    return { verdict: decision.verdict, state: { ...state, settled: decision.settled }, lastTurnAt, next, watch };
  }
  const gate = await login.probe.claim(Math.max(...decision.verdict.moments.map((moment) => moment.at)), tab, now);
  if (gate.kind === 'claim') {
    await runtime.files.append(login.log, `${new Date(now).toISOString()} ${dayProbeClaimLine(`${kit.paths.team}/${id} (${tab})`, gate.why, gate.probe)}\n`);
  }
  if (gate.kind === 'hold') {
    // Decided again so the open moments stay unsettled: the wake decision settled them.
    const held = decideDayStart({ ...input, login: { kind: 'probing', recheckAt: Math.min(now + DAY_PROBE_RECHECK_MS, gate.until) } });
    return { verdict: held.verdict, state: { ...state, settled: held.settled }, lastTurnAt, next, watch: [login.probeFile, login.marker] };
  }
  return { verdict: decision.verdict, state: { ...state, pending: undefined, lastWakeAt: now, settled: decision.settled }, lastTurnAt, next, watch: [] };
}

/**
 * Decides under the session's wake lock, so two tabs of one session never wake it twice. Urgent lines due wake it
 * with any work due as well; the asks a wake takes, and spent ones (damaged, or timed with their line seen), are
 * removed under the lock. A timed ask stays until its time. With a restart held back for work in this tab (`fresh`
 * arms it), a wake starts the session fresh instead: nothing is recorded as woken and no ask taken, so the work wakes
 * the fresh session (T1383); a restart that cannot start lets the wake go ahead.
 *
 * A tab stuck on an expired login is checked first: its retry claims the login marker and comes before all else,
 * since it sends on a turn that was already running, with nothing written to the wake state and no ask taken, so
 * handed work wakes the tab once that turn ends. The budget does not hold it (the turn was spent on before it failed),
 * and no parked restart can stand in for it: a turn that failed ran no Stop hook to park one. A tab whose turn ended
 * on a transient API error (src/restore/api-error.ts) is retried next, the same way, its retry counted in its restore
 * entry.
 */
async function decide(
  runtime: CliRuntime,
  scope: Extract<WakeScope, { kind: 'found' }>,
  store: WakeStore,
  fresh: (() => Promise<boolean>) | undefined,
  login: LoginScope,
): Promise<CheckVerdict> {
  const { config, kit, id, tab } = scope;
  const { files, clock } = runtime;
  const lock = fileLockOf(runtime, store.lockOf(id), { ...config.lock, waitMs: 0 });
  return lock.run(async (): Promise<CheckVerdict> => {
    const now = clock.now();
    const retry = await login.store.claimRetry(tab, now, await files.modifiedAt(login.credentials));
    if (retry.kind === 'retry') {
      return { kind: 'login', why: retry.why, failAt: retry.failAt };
    }
    const api = await claimApiRetry(new RestoreRegistry(files, restoreSessionsDir(kit.paths.kitHome)), tab, now);
    if (api.kind === 'retry') {
      return { kind: 'api', retry: { code: api.code, failAt: api.failedAt, n: api.n } };
    }
    const { snapshot, elsewhere } = await teamRegister(runtime, kit.paths, config).snapshotWithElsewhere();
    const { tasks } = snapshot.state;
    const batchMs = config.wake.batchSeconds * SECOND_MS;
    const asks = new WakeAsks(files, kit.paths.wakeAsks);
    const found = await asksNowOf(await asks.read(id), now, () => unseenLinesOf(inboxDepsOf(runtime, kit.paths), id));
    const asked = askVerdictOf(found, now, batchMs);
    const decision = await restCappedDecision(runtime, scope, {
      tasks,
      elsewhere,
      session: id,
      tab,
      now,
      zone: teamZone(config, runtime),
      maxPriority: config.wake.priority,
      parking: parkRulesOf(config),
      batchMs,
      minGapMs: config.wake.minGapMinutes * MINUTE_MS,
      previous: await store.read(id),
    });
    const handed = decision.verdict.kind === 'wake' || asked.kind === 'wake';
    const started = handed && fresh !== undefined && (await fresh());
    await asks.remove(id, asked.kind === 'wake' && !started ? found.taken : found.spent);
    if (started) {
      return { kind: 'fresh' };
    }
    if (handed) {
      await store.write(id, decision.state);
      return { kind: 'handed', tasks: decision.verdict.kind === 'wake' ? decision.verdict.tasks : [], asks: asked.kind === 'wake' ? asked.asks : [] };
    }
    const day = await momentsOf(runtime, scope, login, tasks, elsewhere, decision.state, now);
    if (day.verdict.kind === 'wake' && fresh !== undefined && (await fresh())) {
      return { kind: 'fresh' };
    }
    await store.write(id, day.state);
    if (day.verdict.kind === 'wake') {
      return { kind: 'moments', moments: day.verdict.moments, tasks: day.verdict.tasks, lastTurnAt: day.lastTurnAt };
    }
    const handedAt = decision.verdict.kind === 'later' ? decision.verdict.at : undefined;
    const askedAt = asked.kind === 'later' ? asked.at : undefined;
    const retryAt = retry.kind === 'later' ? retry.at : undefined;
    const apiAt = api.kind === 'later' ? api.at : undefined;
    const recheckAt = earliest(handedAt, askedAt, day.verdict.kind === 'later' ? day.verdict.at : undefined, day.next, retryAt, apiAt);
    const watch = new Set([...(retry.kind === 'none' ? [] : [login.marker, login.credentials]), ...day.watch]);
    return { kind: 'wait', recheckAt, watch: [...watch] };
  });
}

/**
 * Run by the plugin's mod while its tab is idle at the prompt: whether a turn of the tab that ended on an expired login
 * (src/restore/login.ts) or on a transient API error (src/restore/api-error.ts) should be sent again, logged to the
 * restore log too, else whether new work handed to the
 * tab's session, or an urgent line posted for it (src/wake/asks.ts), should wake it now (src/wake/decide.ts), else
 * whether the day's start or a burst should (src/wake/day-start.ts). On a
 * wake it logs the wake and its cost to the team's wake log and answers the prompt to submit, keeping its text for
 * the turn log (src/wake/prompts.ts); a busy lock (another
 * tab of the session checking) answers a recheck now. The lead is not woken while the owner's daily meeting is open,
 * nor any session while its automatic restart may still act; one whose restart died is restarted again instead, and
 * one whose restart waits for work is restarted for the work that would wake it (T1383). It also runs the team's idle
 * pass, at most once a minute across the team (hook-idle-pass.ts).
 */
export async function wakeCheck(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const scope = await wakeScopeOf(runtime, payload, true);
  if (scope.kind === 'off') {
    return answer(runtime, scope);
  }
  const { kit, config, id, tab } = scope;
  // The pass is the team's, not this tab's wake: before the holds that keep only this session from waking.
  await runIdlePass(runtime, kit, config, scope.roster, scope.from);
  if (await meetingHoldsWake(runtime, scope)) {
    return answer(runtime, waitAnswer(scope, null));
  }
  const restarts = new RefreshStore(runtime.files, kit.paths);
  const rearm: RearmScope = { team: kit.paths.team, id, tab, refresh: config.refresh, cwd: isRecord(payload) ? stringField(payload, 'cwd') : undefined };
  if (await restartHoldsWake(runtime, restarts, rearm)) {
    return answer(runtime, waitAnswer(scope, runtime.clock.now() + RESTART_RECHECK_MS));
  }
  const parked = await parkedHere(restarts, rearm);
  const fresh = parked === undefined ? undefined : (): Promise<boolean> => armParkedRestart(runtime, restarts, rearm, parked);
  const store = new WakeStore(runtime.files, kit.paths.wake);
  const login = loginScopeOf(runtime, kit.paths.kitHome);
  let verdict: CheckVerdict;
  try {
    verdict = await decide(runtime, scope, store, fresh, login);
  } catch (error) {
    if (error instanceof LockBusyError) {
      return answer(runtime, waitAnswer(scope, runtime.clock.now()));
    }
    throw error;
  }
  if (verdict.kind === 'wait') {
    return answer(runtime, waitAnswer(scope, verdict.recheckAt, verdict.watch));
  }
  if (verdict.kind === 'fresh') {
    return answer(runtime, waitAnswer(scope, runtime.clock.now() + RESTART_RECHECK_MS));
  }
  const now = runtime.clock.now();
  const last = verdict.kind === 'moments' ? verdict.lastTurnAt : await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), [tab]);
  const wPerPct = await readTodayWPerPct(runtime, kit.paths, config, now);
  const cost = wakeCost(last === undefined ? undefined : now - last, config.messages.coldAfterMinutes, wPerPct);
  if (verdict.kind === 'login') {
    await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids: [], cost, retry: 'login' });
    await runtime.files.append(login.log, `${new Date(now).toISOString()} ${loginRetryLine(`${kit.paths.team}/${id} (${tab})`, verdict.why)}\n`);
    const text = loginRetryPrompt(id, verdict.failAt, verdict.why, cost, teamZone(config, runtime));
    return wake(runtime, scope, { kind: 'wake', ids: [], text, toast: loginRetryToast(verdict.why, cost) });
  }
  if (verdict.kind === 'api') {
    const { retry } = verdict;
    await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids: [], cost, retry: 'api' });
    await runtime.files.append(login.log, `${new Date(now).toISOString()} ${apiRetryLine(`${kit.paths.team}/${id} (${tab})`, retry.code, retry.n)}\n`);
    const text = apiRetryPrompt(id, retry, cost, teamZone(config, runtime));
    return wake(runtime, scope, { kind: 'wake', ids: [], text, toast: apiRetryToast(retry, cost) });
  }
  const ids = verdict.tasks.map((task) => task.id);
  if (verdict.kind === 'handed') {
    const { tasks, asks } = verdict;
    await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost, ...(asks.length === 0 ? {} : { asks: asks.length }) });
    const text = handedPrompt(id, tasks, asks, cost, teamZone(config, runtime));
    return wake(runtime, scope, { kind: 'wake', ids, text, toast: handedToast(tasks, asks, cost) });
  }
  const moments = verdict.moments.map((moment) => moment.kind);
  await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost, moments });
  const text = dayStartPrompt(id, scope.roster.nameOf(id) ?? id, verdict.moments, verdict.tasks, cost, teamZone(config, runtime));
  return wake(runtime, scope, { kind: 'wake', ids, text, toast: dayStartToast(verdict.moments, verdict.tasks, cost) });
}

/** Answers a wake, keeping its text first with the turn log on, so the prompt it submits is logged as teamrig's. */
async function wake(runtime: CliRuntime, scope: Extract<WakeScope, { kind: 'found' }>, value: Extract<WakeAnswer, { kind: 'wake' }>): Promise<ExitCode> {
  if (scope.config.turnLog.enabled) {
    await new WakePrompts(runtime.files, scope.kit.paths.wake).remember(scope.id, { tab: scope.tab, text: value.text });
  }
  return answer(runtime, value);
}

/**
 * Run by the mod when Claude Code dropped a wake it submitted (a prompt hook refused it): logs it with the reason and
 * forgets its text, so a prompt the person types later is never taken for it.
 */
export async function wakeDropped(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const scope = await wakeScopeOf(runtime, payload, false);
  if (scope.kind === 'off') {
    return EXIT.ok;
  }
  const reason = (isRecord(payload) ? stringField(payload, 'reason') : undefined) ?? 'no reason given';
  await logWake(runtime.files, scope.kit.paths.wakeLog, { kind: 'dropped', at: runtime.clock.now(), session: scope.id, tab: scope.tab, reason });
  await new WakePrompts(runtime.files, scope.kit.paths.wake).forget(scope.id, scope.tab);
  return EXIT.ok;
}
