import { claudeProjectsDir, lastWriteOf } from "../../budget/discover.js";
import { isRecord, stringField } from "../../core/guards.js";
import { FileLock, LockBusyError } from "../../core/lock.js";
import { MeetingStore, phaseOf } from "../../meeting/state.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { decideWake, effectivePriority, URGENT_PRIORITY, wakeCost, wakePrompt, wakeRestOf, wakeToast } from "../../wake/decide.js";
import { logWake, WakeStore } from "../../wake/store.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { budgetFactsOf } from "./hook-budget.js";
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
    return id === undefined ? { kind: 'off', why: 'this tab is not a team session' } : { kind: 'found', kit, config, roster, id, tab };
}
/**
 * The least urgent priority that wakes the session now. Waking for p1 alone needs no budget read; for more, a
 * session past its daily budget or in the budget's quiet hours (unless its lift exempts it) still wakes for p1 only.
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
/** Decides under the session's wake lock, so two tabs of one session never wake it twice. */
async function decide(runtime, scope, store) {
    const { config, kit, id, tab } = scope;
    const { files, clock, sleep, pid } = runtime;
    const lock = new FileLock(store.lockOf(id), { ...config.lock, waitMs: 0 }, { files, clock, sleep, pid });
    return lock.run(async () => {
        const { tasks } = (await teamRegister(runtime, kit.paths, config).snapshot()).state;
        const decision = decideWake({
            tasks,
            session: id,
            tab,
            now: clock.now(),
            maxPriority: await maxPriorityOf(runtime, scope),
            batchMs: config.wake.batchSeconds * SECOND_MS,
            minGapMs: config.wake.minGapMinutes * MINUTE_MS,
            previous: await store.read(id),
        });
        await store.write(id, decision.state);
        return decision.verdict;
    });
}
/**
 * Run by the plugin's mod while its tab is idle at the prompt: whether new work handed to the tab's session should
 * wake it now (src/wake/decide.ts). On a wake it logs the wake and its cost to the team's wake log and answers the
 * prompt to submit; a busy lock (another tab of the session checking) answers a recheck now. The lead is not woken
 * while the owner's daily meeting is open.
 */
export async function wakeCheck(args, runtime) {
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
    if (verdict.kind !== 'wake') {
        return answer(runtime, { kind: 'wait', watch: kit.paths.events, recheckAt: verdict.kind === 'later' ? verdict.at : null });
    }
    const now = runtime.clock.now();
    const last = await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), [tab]);
    const cost = wakeCost(last === undefined ? undefined : now - last, config.messages.coldAfterMinutes, config.budget.weeklyLimitW);
    const ids = verdict.tasks.map((task) => task.id);
    await logWake(runtime.files, kit.paths.wakeLog, { kind: 'wake', at: now, session: id, tab, ids, cost });
    return answer(runtime, { kind: 'wake', ids, text: wakePrompt(id, verdict.tasks, cost), toast: wakeToast(verdict.tasks, cost) });
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
