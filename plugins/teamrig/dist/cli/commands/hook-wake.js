import { activeBurst } from "../../budget/burst.js";
import { BurstLog } from "../../budget/burst-log.js";
import { claudeProjectsDir, lastWriteOf } from "../../budget/discover.js";
import { isRecord, stringField } from "../../core/guards.js";
import { FileLock, LockBusyError } from "../../core/lock.js";
import { MeetingStore, phaseOf } from "../../meeting/state.js";
import { restartMayAct } from "../../refresh/restart.js";
import { RefreshStore } from "../../refresh/store.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { dayStartPrompt, dayStartToast, decideDayStart, dueMoments, nextDayStartAt, startableTasks } from "../../wake/day-start.js";
import { decideWake, effectivePriority, URGENT_PRIORITY, wakeCost, wakePrompt, wakeRestOf, wakeToast } from "../../wake/decide.js";
import { logWake, WakeStore } from "../../wake/store.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
import { readWPerPct } from "../stored-week.js";
import { teamRegister } from "../team-register.js";
import { budgetFactsOf } from "./hook-budget.js";
import { runIdlePass } from "./hook-idle-pass.js";
import { parseJson, sessionTeam, teamSessionOf } from "./hook-input.js";
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
function answer(runtime, value) {
    runtime.out.stdout(JSON.stringify(value));
    return EXIT.ok;
}
async function scopeOf(runtime, payload, needsWake) {
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
/**
 * The least urgent priority that wakes the session now. Waking for p1 alone needs no budget read; for more, a
 * session its budget holds (past its daily budget while the team has no room today) or in the budget's quiet hours
 * (unless its lift exempts it) still wakes for p1 only.
 */
async function maxPriorityOf(runtime, scope) {
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
async function meetingHoldsWake(runtime, scope) {
    if (scope.roster.holderOf('lead') !== scope.id) {
        return false;
    }
    const meeting = await new MeetingStore(runtime.files, scope.kit.paths.meeting).read();
    return phaseOf(meeting, runtime.clock.now()).kind === 'open';
}
/** How soon a check that a pending restart held looks again: the restart may end meanwhile without a register change. */
export const RESTART_RECHECK_MS = MINUTE_MS;
/**
 * While the session's automatic restart may still act (src/refresh/restart.ts), it is not woken: the wake's prompt
 * would cancel the restart as a typed one does (`hook prompt`), leaving the session with its handover written and no
 * fresh start. The work handed meanwhile stays new, so it wakes the fresh session.
 */
async function restartHoldsWake(runtime, scope) {
    const request = await new RefreshStore(runtime.files, scope.kit.paths).restart(scope.id);
    return restartMayAct(request, runtime.clock.now());
}
/** The earliest of the times given; null with none. */
function earliest(...times) {
    const set = times.filter((time) => time !== undefined);
    return set.length === 0 ? null : Math.min(...set);
}
/**
 * The day's moments (src/wake/day-start.ts), checked when no handed work wakes the session and only with
 * `wake.dayStartUtc` set. The budget and the tab's last turn are read only once a moment is due and the session has
 * work it can start; a moments wake takes in any batch still pending, since it names all that work.
 */
async function momentsOf(runtime, scope, tasks, state, now) {
    const { config, kit, roster, id, tab } = scope;
    const { dayStartUtc } = config.wake;
    if (dayStartUtc === undefined) {
        return { verdict: { kind: 'none' }, state, lastTurnAt: undefined, next: undefined };
    }
    const next = nextDayStartAt(dayStartUtc, now);
    const none = { verdict: { kind: 'none' }, state, lastTurnAt: undefined, next };
    const startable = startableTasks(tasks, id, now, teamZone(config, runtime));
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
async function decide(runtime, scope, store) {
    const { config, kit, id, tab } = scope;
    const { files, clock, sleep, pid } = runtime;
    const lock = new FileLock(store.lockOf(id), { ...config.lock, waitMs: 0 }, { files, clock, sleep, pid });
    return lock.run(async () => {
        const { tasks } = (await teamRegister(runtime, kit.paths, config).snapshot()).state;
        const now = clock.now();
        const decision = decideWake({
            tasks,
            session: id,
            tab,
            now,
            zone: teamZone(config, runtime),
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
 * tab of the session checking) answers a recheck now. The lead is not woken while the owner's daily meeting is open,
 * nor any session while its automatic restart may still act. It also runs the team's idle pass, once a minute across
 * the team (hook-idle-pass.ts).
 */
export async function wakeCheck(args, runtime) {
    noPositionals(args);
    const scope = await scopeOf(runtime, parseJson(await runtime.readStdin()), true);
    if (scope.kind === 'off') {
        return answer(runtime, scope);
    }
    const { kit, config, id, tab } = scope;
    // The pass is the team's, not this tab's wake: before the holds that keep only this session from waking.
    await runIdlePass(runtime, kit, config, scope.roster, scope.from);
    if (await meetingHoldsWake(runtime, scope)) {
        return answer(runtime, { kind: 'wait', watch: kit.paths.events, recheckAt: null });
    }
    if (await restartHoldsWake(runtime, scope)) {
        return answer(runtime, { kind: 'wait', watch: kit.paths.events, recheckAt: runtime.clock.now() + RESTART_RECHECK_MS });
    }
    const store = new WakeStore(runtime.files, kit.paths.wake);
    let verdict;
    try {
        verdict = await decide(runtime, scope, store);
    }
    catch (error) {
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
    const wPerPct = await readWPerPct(runtime, kit.paths, config, now);
    const cost = wakeCost(last === undefined ? undefined : now - last, config.messages.coldAfterMinutes, wPerPct);
    const ids = verdict.tasks.map((task) => task.id);
    if (verdict.kind === 'handed') {
        await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost });
        return answer(runtime, { kind: 'wake', ids, text: wakePrompt(id, verdict.tasks, cost), toast: wakeToast(verdict.tasks, cost) });
    }
    const moments = verdict.moments.map((moment) => moment.kind);
    await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost, moments });
    const text = dayStartPrompt(id, scope.roster.nameOf(id) ?? id, verdict.moments, verdict.tasks, cost, teamZone(config, runtime));
    return answer(runtime, { kind: 'wake', ids, text, toast: dayStartToast(verdict.moments, verdict.tasks, cost) });
}
/** Run by the mod when Claude Code dropped a wake it submitted (a prompt hook refused it): logs it with the reason. */
export async function wakeDropped(args, runtime) {
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
