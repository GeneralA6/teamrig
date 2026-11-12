import { isRecord, stringField } from "../../core/guards.js";
import { sessionDisplay } from "../../core/ids.js";
import { LockBusyError } from "../../core/lock.js";
import { showNotice } from "../../meeting/notify.js";
import { MeetingStore, phaseOf } from "../../meeting/state.js";
import { focusTab } from "../../open/focus.js";
import { runsClaude } from "../../open/session-processes.js";
import { TabNeedStore } from "../../tabs/need.js";
import { asksFor, NeedsYouSent, offersFocus } from "../../tabs/needs-you.js";
import { noPositionals } from "../args.js";
import { fileLockOf } from "../file-locks.js";
import { EXIT } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { parseJson } from "./hook-input.js";
import { wakeScopeOf } from "./hook-wake.js";
function answer(runtime, value) {
    runtime.out.stdout(JSON.stringify(value));
    return EXIT.ok;
}
/** The scope of a needs-you hook: a team tab whose team has needsYou on. */
async function scopeOf(runtime, payload) {
    const scope = await wakeScopeOf(runtime, payload, false);
    if (scope.kind === 'found' && !scope.config.needsYou.enabled) {
        return { kind: 'off', why: 'needsYou.enabled is false' };
    }
    return scope;
}
/**
 * The team's asks now (own: null for every tab's), of the kinds the config names. A file whose Claude Code process no
 * longer runs is a tab that ended without its SessionEnd (a crash, a killed window): it asks nobody. A file with no
 * process recorded is kept, since nothing tells it ended. Sessions off the roster are left out.
 */
async function liveAsks(runtime, scope, own) {
    const tabs = await new TabNeedStore(runtime.files, scope.kit.paths).readAll();
    const members = new Set(scope.roster.ids);
    const asks = asksFor(tabs, own, scope.config.needsYou.kinds).filter((need) => members.has(need.session));
    const live = await Promise.all(asks.map(async (need) => need.pid === null || (await runsClaude(runtime.sessionProcesses, need.pid))));
    return asks.filter((_, index) => live[index] === true);
}
async function meetingOpen(runtime, scope) {
    return phaseOf(await new MeetingStore(runtime.files, scope.kit.paths.meeting).read(), runtime.clock.now()).kind === 'open';
}
/** Whether each ask offers its Focus; the register is read only during an open meeting with an ask naming a task. */
async function focusGateOf(runtime, scope, asks) {
    if (!(await meetingOpen(runtime, scope))) {
        return () => true;
    }
    if (asks.every((need) => need.task === null)) {
        return () => false;
    }
    const { tasks } = (await teamRegister(runtime, scope.kit.paths, scope.config).snapshot()).state;
    return (need) => offersFocus(true, need.task === null ? undefined : tasks.get(need.task)?.priority);
}
function tabOf(scope, session) {
    return sessionDisplay(scope.kit.paths.team, scope.roster.nameOf(session) ?? session);
}
/**
 * The OS notification of each team ask not told of yet, when `needsYou.osToast` is on: marked under the lock first, so
 * one tab of the team sends each. A busy lock leaves them to the next look of any tab.
 */
async function notifyNew(runtime, scope) {
    const all = await liveAsks(runtime, scope, null);
    const sent = new NeedsYouSent(runtime.files, scope.kit.paths.needsYouSent);
    let fresh;
    try {
        fresh = await fileLockOf(runtime, scope.kit.paths.needsYouLock, scope.config.lock).run(() => sent.markNew(all));
    }
    catch (error) {
        if (error instanceof LockBusyError) {
            return;
        }
        throw error;
    }
    for (const need of fresh) {
        await showNotice(runtime.processes, runtime.platform, { title: `${tabOf(scope, need.session)} needs you`, text: need.text }, runtime.env, runtime.cwd);
    }
}
/**
 * `hook needs-you`, run by the mod's NeedsYouHand in every open tab of the team every few seconds (T2511): the asks of
 * the team's other tabs (a permission prompt, a question, a form, a decision line), newest first, for the tab's toast
 * and its band with Focus and Dismiss. During the owner's open meeting the band offers Focus only for a p0 task's ask.
 * With `needsYou.osToast` on it also sends one OS notification per ask across the team.
 */
export async function needsYou(args, runtime) {
    noPositionals(args);
    const scope = await scopeOf(runtime, parseJson(await runtime.readStdin()));
    if (scope.kind === 'off') {
        return answer(runtime, scope);
    }
    if (scope.config.needsYou.osToast) {
        await notifyNew(runtime, scope);
    }
    const asks = await liveAsks(runtime, scope, scope.id);
    const focus = await focusGateOf(runtime, scope, asks);
    const shown = asks.map((need) => ({
        session: need.session,
        tab: tabOf(scope, need.session),
        kind: need.kind,
        text: need.text,
        task: need.task,
        since: need.since,
        focus: focus(need),
    }));
    return answer(runtime, { kind: 'asks', asks: shown });
}
/** The text of a focus outcome, as `meeting start` words its own. */
function focusText(outcome, title) {
    switch (outcome.kind) {
        case 'focused':
            return `focused ${title}`;
        case 'behind':
            return `selected ${title} in its window; Windows kept another app's window in front`;
        case 'none':
            return `could not focus ${title}: ${outcome.reasons.join('; ')}`;
    }
}
/**
 * `hook needs-you-focus`, stdin `{"session_id", "cwd", "session"}`: the band's Focus, which brings the asking tab of
 * `session` to the front as `meeting start` does (open/focus.ts). Refused unless that tab asks now and its ask offers
 * Focus (the meeting gate), so a stale band moves nothing.
 */
export async function needsYouFocus(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const scope = await scopeOf(runtime, payload);
    if (scope.kind === 'off') {
        return answer(runtime, scope);
    }
    const target = isRecord(payload) ? stringField(payload, 'session') : undefined;
    if (target === undefined) {
        return answer(runtime, { kind: 'refused', why: 'stdin names no session' });
    }
    const need = (await liveAsks(runtime, scope, scope.id)).find((each) => each.session === target);
    if (need === undefined) {
        return answer(runtime, { kind: 'refused', why: `${target} asks nothing now` });
    }
    if (!(await focusGateOf(runtime, scope, [need]))(need)) {
        return answer(runtime, { kind: 'refused', why: `the owner's meeting is open and ${target}'s ask is no p0 task's` });
    }
    const title = tabOf(scope, target);
    const outcome = await focusTab(runtime, scope.config.open.terminal, title, runtime.cwd);
    return answer(runtime, { kind: outcome.kind, text: focusText(outcome, title) });
}
