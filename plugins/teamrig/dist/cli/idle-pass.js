import { KIT_NAME } from "../core/home.js";
import { parkRulesOf } from "../register/park.js";
import { noRoomText } from "../sessions/headroom.js";
import { reopenVerdict } from "../sessions/idle.js";
import { closedOf, SessionLog } from "../sessions/log.js";
import { urgentLinesText } from "../wake/asks.js";
import { byUrgency, COLD_WAKE_W, effectivePriority, HELD_PRIORITY, wakeRestOf } from "../wake/decide.js";
import { budgetFactsOf } from "./commands/hook-budget.js";
import { dayStartFor } from "./day-schedule.js";
import { headroomOf } from "./headroom.js";
import { closableText, idleFactsOf, idleVerdictOf } from "./idle-check.js";
import { RefusedError } from "./runtime.js";
import { installStateOf, settleWaitText } from "./settled-install.js";
/** A session the budget neither holds nor puts in quiet hours. */
const AWAKE = { held: false, quiet: false };
/** The session's folder; one refused holds only its own session, so the pass goes on for the rest. */
async function folderOrRefusalOf(folderOf, id) {
    try {
        return { kind: 'folder', project: await folderOf(id) };
    }
    catch (error) {
        if (error instanceof RefusedError) {
            return { kind: 'refused', why: error.message };
        }
        throw error;
    }
}
/** The pass's pick: urgent lines first, the oldest first, then the most urgent top task. */
function byReopenOrder(a, b) {
    if (a.reopening.kind === 'asked') {
        return b.reopening.kind === 'asked' ? a.reopening.at - b.reopening.at : -1;
    }
    if (b.reopening.kind === 'asked') {
        return 1;
    }
    return a.top === undefined || b.top === undefined ? 0 : byUrgency(a.top, b.top);
}
/**
 * The session's rest and the least urgent priority up to `configured` that wakes it now, as `hook wake-check` weighs
 * them: a session its budget holds or a short day pauses wakes, and so stays open, for p0 only, one in the budget's
 * quiet hours for p1 and p0, p0 alone when they block (`effectivePriority`). The wake it weighs is counted cold: a closed session reopens cold,
 * and a running one the pass would close has been quiet `open.headroom.closeIdleMinutes`.
 */
async function wakeWeightOf(runtime, kit, config, roster, id, configured) {
    const rest = config.budget.enabled ? wakeRestOf(await budgetFactsOf(runtime, { kit, config, roster, id }, undefined), config.budget.quietHours, runtime.clock.now(), COLD_WAKE_W) : AWAKE;
    return { rest, maxPriority: effectivePriority(configured, rest, config.budget.quietHours) };
}
/**
 * True when the session has an unfinished task past p0 within `configured`: the only tasks a rest (which caps that
 * priority at p0 or p1) can take out of a running session's verdict.
 */
function hasWorkARestCuts(tasks, id, configured) {
    return [...tasks.values()].some((task) => task.owner === id && task.priority > HELD_PRIORITY && task.priority <= configured && task.status !== 'done' && task.status !== 'dropped');
}
/**
 * The least urgent priority up to `configured` whose work keeps the running session `id` open, weighed as `hook
 * wake-check` weighs it ({@link wakeWeightOf}). Its budget takes thousands of file reads, so it counts as awake
 * unless its rest can change the verdict: when it has work a rest cuts ({@link hasWorkARestCuts}).
 */
export async function restCappedPriority(runtime, kit, config, roster, tasks, id, configured) {
    return hasWorkARestCuts(tasks, id, configured) ? (await wakeWeightOf(runtime, kit, config, roster, id, configured)).maxPriority : configured;
}
/** Whether the running session `id` closes, its work weighed as `hook wake-check` weighs it: work that would wake it keeps it open. */
export async function runningVerdictOf(runtime, kit, config, roster, facts, id, project) {
    const maxPriority = await restCappedPriority(runtime, kit, config, roster, facts.tasks, id, config.wake.priority);
    return idleVerdictOf(runtime, config, roster, facts, id, { maxPriority, project });
}
/**
 * One session's step, or its wish to reopen: a running one by {@link runningVerdictOf}, a closed one counted awake
 * unless it would reopen awake for work (a rest only holds such a reopen back, never one for urgent lines), since its
 * budget takes thousands of file reads. One whose folder is refused stays as it is, its refusal the why: kept open, or
 * its reopen left for later.
 */
export async function judgeSession(runtime, kit, config, roster, facts, id, folderOf, closes) {
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
    const input = { tasks, elsewhere, session: id, asks, closedAt: Date.parse(closed.at), ...awake, parking: parkRulesOf(config), dayStart: (await dayStartFor(runtime, { kit, config }, id, now)).at, now, zone };
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
async function wishOf(folderOf, id, reopening, top) {
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
export async function idlePassOf(runtime, kit, config, roster, folderOf) {
    const facts = await idleFactsOf(runtime, kit, config, roster);
    const closes = (await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records;
    const judged = [];
    for (const id of roster.ids) {
        judged.push(await judgeSession(runtime, kit, config, roster, facts, id, folderOf, closes));
    }
    const [first] = judged.filter((step) => step.kind === 'wish').sort(byReopenOrder);
    const hold = first === undefined ? undefined : await reopenHoldOf(runtime, kit, config, roster, first.project, first.id);
    return judged.map((step) => {
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
async function reopenHoldOf(runtime, kit, config, roster, project, id) {
    const install = await installStateOf(runtime, project);
    if (install.kind === 'unsettled') {
        return settleWaitText(install.why);
    }
    const room = await headroomOf(runtime, kit.paths, config, roster.ids);
    return room.short.length === 0 ? undefined : noRoomText(`reopen ${roster.nameOf(id) ?? id}`, room);
}
function idsText(tasks) {
    return tasks.map((task) => task.id).join(', ');
}
/** Why a closed session reopens, as the pass's lines say it. */
export function reopeningText(reopening, zone) {
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
export function passLineOf(step, roster, zone) {
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
export function passTotalOf(steps) {
    const count = (kind) => steps.filter((step) => step.kind === kind).length;
    return `PASS ${steps.length} session(s): ${count('close')} to close, ${count('reopen')} to reopen, ${count('later')} to reopen later, ${count('keep')} kept open, ${count('closed')} closed, ${count('away')} away; nothing changed`;
}
