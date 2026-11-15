import { sessionDisplay } from "../core/ids.js";
import { lineHash } from "../inbox/line-hash.js";
/**
 * The smallest context window of a current Claude model, which `decideCompact` takes for a window it is not told: a
 * ceiling at or past it holds nothing, so on a larger window the hold lets go sooner than it could, never past the
 * room the window has.
 */
export const SMALLEST_MODEL_WINDOW = 200_000;
const NONE = { kind: 'none' };
const MEASURE = { kind: 'measure' };
const GO = { kind: 'go' };
/**
 * A session that goes on without the fresh start a refresh asked for (the user typed, or never typed /clear) is
 * asked again once its context grew this share of `contextTokens` past the size it was asked at, or at its next
 * task end: never at every turn end.
 */
export const REASK_SHARE = 0.2;
/**
 * An open owner meeting holds the refresh of each session in it (the lead in its daily meeting; the session met and
 * those joining in a booked one): no ask, no notice and so no restart, which would cut the meeting off, until the
 * turn end after `meeting end` (or the meeting's lapse), which asks at once when the context is past the threshold.
 * Up to `compactCeilingTokens` only: past it the refresh goes
 * on even in the meeting, as Claude Code's own compaction does (`decideCompact`), so the session never runs out of
 * room in it. Under it, only a handover asked for or written stops that compaction, so a session the meeting kept
 * from being asked still compacts when Claude Code needs room. 0, which never stops a compaction, sets no ceiling;
 * a size the transcript does not tell is held.
 */
export function meetingHolds(settings, meeting, tokens) {
    const ceiling = settings.compactCeilingTokens;
    return meeting && (ceiling === 0 || tokens === undefined || tokens < ceiling);
}
/** How far a context grows past a refresh it went on from before it is asked again. */
export function reaskGrowth(settings) {
    return Math.round(settings.contextTokens * REASK_SHARE);
}
/** Tokens as people say them: 262,144 is `262k`. */
export function thousands(tokens) {
    return `${Math.round(tokens / 1000)}k`;
}
/** What the notice says comes next, and the tab mark for it. */
const NEXT_TEXT = {
    restart: (context) => ({
        text: `${context.command} starts it fresh once it has been idle ${context.settings.restartDelaySeconds} s (type anything to keep this context)`,
        mark: 'restarting',
    }),
    park: (context) => ({
        text: `it has no work it can start now, so ${context.command} starts it fresh once a wake brings it some (type anything to keep this context)`,
        mark: 'waits for work',
    }),
    clear: () => ({ text: 'type /clear for a fresh start', mark: 'type /clear' }),
};
/** The notice that `state`'s handover is written, and what comes `next`. */
export function noticeOf(state, context, next) {
    const { name } = context.session;
    const { text, mark } = NEXT_TEXT[next](context);
    const finished = state.task === null ? '' : ` finished ${state.task} and`;
    return {
        kind: 'notice',
        state: { ...state, noticed: true, transcript: context.transcript },
        message: `${context.command}: ${name}${finished} wrote its handover; ${text}`,
        title: context.settings.tabTitle ? `${sessionDisplay(context.session.team, name)}: ${mark}` : undefined,
        restart: next === 'restart',
    };
}
/** The command that tells the kit the handover is written; `--session` so it works without `$TEAMRIG_SESSION`. */
export function readyCommand(command, session) {
    return `${command} refresh --ready --session ${session}`;
}
/** The tasks finished since the context was last fresh, before this one: only a boundary or a judged one counts them. */
function finishedSoFar(state) {
    return state?.phase === 'boundary' || state?.phase === 'idle' ? state.finished : 0;
}
/**
 * The ask for the handover that `refresh --ready` answers: the one the session is in, or the one a task end since
 * left standing on its boundary; null when none is pending.
 */
export function standingAsk(state) {
    if (state?.phase === 'asked') {
        const { task, at, tokens, handoverHash } = state;
        return { task, at, tokens, handoverHash, ...(state.fixHash === undefined ? {} : { fixHash: state.fixHash }) };
    }
    return state?.phase === 'boundary' ? state.ask : null;
}
/**
 * `set <id> --status done`: the boundary the Stop hook judges, counting this task. A refresh pending then outlasts the
 * task end (T1666): an ask not yet answered stands on the boundary, so `refresh --ready` still answers it, and a
 * handover marked ready but not yet announced stays as it is, so the turn end announces it. The Stop hook judges the
 * boundary as before, so a turn end that does not ask again drops the standing ask.
 */
export function boundaryOf(previous, task, at) {
    if (previous?.phase === 'ready' && !previous.noticed) {
        return previous;
    }
    return { phase: 'boundary', task, at, finished: finishedSoFar(previous) + 1, ask: standingAsk(previous), ...keepBaseline(previous), ...keepWindow(previous) };
}
/** The baseline of a state that keeps one: a number once measured, null while a fresh start waits for it, undefined for none. */
function baselineOf(state) {
    return state?.phase === 'refreshed' || state?.phase === 'boundary' || state?.phase === 'idle' ? state.baseline : undefined;
}
/**
 * A fresh start whose context was not measured yet: a fresh session can start over the threshold (its system
 * prompt, rules and handover read alone), so its first measure only records that size and never asks for a refresh.
 */
function unmeasured(state) {
    return baselineOf(state) === null;
}
/**
 * The smallest context a size or task-count ask needs: real growth, `reaskGrowth`, past the size the session had once
 * fresh (its baseline); 0 without one. So a refresh never comes twice without work between.
 */
export function growthFloor(state, settings) {
    const baseline = baselineOf(state);
    return typeof baseline === 'number' ? baseline + reaskGrowth(settings) : 0;
}
/**
 * The context size a turn end, or a tool result within a turn, asks at: the threshold, past the growth floor of a
 * fresh start, or after a refresh the session went on from, well past that ask.
 */
function askAt(state, settings) {
    const asked = state?.phase === 'asked' || state?.phase === 'ready' ? state.tokens : null;
    const floor = Math.max(settings.contextTokens, growthFloor(state, settings));
    return asked === null ? floor : Math.max(floor, asked + reaskGrowth(settings));
}
/**
 * Whether the session runs on a window larger than 200k, as `state` keeps it: its `largeWindow`, or in a file
 * from before that field a fresh start measured over the threshold, which a 200k window cannot start past and keep
 * working.
 */
function largeWindowOf(state, settings) {
    const known = state?.largeWindow;
    if (known !== undefined) {
        return known;
    }
    const baseline = baselineOf(state);
    return typeof baseline === 'number' && baseline > settings.contextTokens;
}
/**
 * The window `state` keeps once the context measured `tokens`, with the `window` the plugin's mod reports when it does
 *. A hook is never told the window, and a model can run a 1M-token one without the `[1m]` suffix (the lead's
 * plain `opus`), so the evidence decides: the mod's window first; else a context past `SMALLEST_MODEL_WINDOW`, which
 * no 200k window holds; else a fresh start's first measure judges it anew by its size over the threshold, so a later
 * start on a smaller window drops what an earlier one showed; else what the state kept. Undefined: nothing tells.
 * Where the larger threshold would raise nothing (`largeWindowContextTokens` 0, or not over `contextTokens`, as on a
 * `[1m]` launch already raised), the state keeps what it has.
 */
export function windowOf(state, settings, tokens, window) {
    if (settings.largeWindowContextTokens <= settings.contextTokens) {
        return state?.largeWindow;
    }
    if (window !== undefined) {
        return window > SMALLEST_MODEL_WINDOW;
    }
    if (tokens !== undefined && tokens > SMALLEST_MODEL_WINDOW) {
        return true;
    }
    if (tokens !== undefined && unmeasured(state)) {
        return tokens > settings.contextTokens ? true : undefined;
    }
    return state?.largeWindow ?? (largeWindowOf(state, settings) ? true : undefined);
}
/** The threshold of a session whose window is `large`: `largeWindowContextTokens` on a large one, when that is larger. */
function thresholdFor(large, settings) {
    return large === true ? Math.max(settings.contextTokens, settings.largeWindowContextTokens) : settings.contextTokens;
}
/** `settings` with the threshold of a session whose window is `large` (`thresholdFor`). */
function sizedFor(large, settings) {
    const contextTokens = thresholdFor(large, settings);
    return contextTokens === settings.contextTokens ? settings : { ...settings, contextTokens };
}
/**
 * The context size a session with `state` is asked to refresh at, before the growth floor: `contextTokens`, or on a
 * window `state` shows to be large `largeWindowContextTokens` when that is larger.
 */
export function thresholdOf(state, settings) {
    return thresholdFor(largeWindowOf(state, settings), settings);
}
/** `state` keeping the window `large`; the same state when it kept that already, undefined for none. */
function recorded(state, large) {
    if (state === undefined || state.largeWindow === large) {
        return state;
    }
    if (large === undefined) {
        const { largeWindow: _dropped, ...rest } = state;
        return rest;
    }
    return { ...state, largeWindow: large };
}
/** The window field a state carries on to the next one: absent while nothing told. */
function keepWindow(state) {
    return windowField(state?.largeWindow);
}
function windowField(large) {
    return large === undefined ? {} : { largeWindow: large };
}
/** `state` with the baseline its fresh start's first measure took. */
function measuredState(state, tokens) {
    return state.phase === 'refreshed' || state.phase === 'boundary' || state.phase === 'idle' ? { ...state, baseline: tokens } : state;
}
/** The baseline field a state carries on to the next one: absent when there is none. */
function keepBaseline(state) {
    const baseline = baselineOf(state);
    return baseline === undefined ? {} : { baseline };
}
/**
 * Why this turn end refreshes, if it does: the lead asked, or the context reached `askAt`; at a task end
 * (`boundary`) also enough tasks at a context worth refreshing. A session asked before that went on is not
 * asked again for the lead's request it was already asked for.
 */
function causeOf(state, facts, settings) {
    const askedBefore = state?.phase === 'asked' || state?.phase === 'ready';
    if (facts.requestedBy !== undefined && !askedBefore) {
        return { kind: 'asked', by: facts.requestedBy, tokens: facts.tokens ?? null };
    }
    const { tokens } = facts;
    // A fresh start's first measure records its size and asks nothing: see `decideStop`.
    if (tokens === undefined || unmeasured(state)) {
        return undefined;
    }
    if (tokens >= askAt(state, settings)) {
        return { kind: 'size', tokens };
    }
    if (state?.phase !== 'boundary') {
        return undefined;
    }
    const minTokens = Math.max(settings.everyTasksMinTokens, growthFloor(state, settings));
    const counted = settings.everyTasks > 0 && state.finished >= settings.everyTasks && tokens >= minTokens;
    return counted ? { kind: 'tasks', tokens, finished: state.finished } : undefined;
}
function whyOf(cause, settings) {
    switch (cause.kind) {
        case 'size':
            return `your context is ${thousands(cause.tokens)} (refresh at ${thousands(settings.contextTokens)})`;
        case 'tasks':
            return `your context is ${thousands(cause.tokens)} after ${cause.finished} tasks (refresh every ${settings.everyTasks} tasks)`;
        case 'asked':
            return `${cause.by} asked for a refresh${cause.tokens === null ? '' : ` (your context is ${thousands(cause.tokens)})`}`;
        case 'pending':
            return `the refresh asked within this turn${cause.tokens === null ? '' : ` at ${thousands(cause.tokens)}`} is still due`;
    }
}
function whenOf(moment) {
    if (moment.kind === 'midTurn') {
        return ', so refresh within this turn: finish the step you are on and start no other';
    }
    return moment.task === null ? ', so refresh now rather than at a task end' : ` and you just finished ${moment.task}`;
}
/**
 * What the ask adds while background work the session started still runs: the handover says what each result still
 * needs, since the fresh start, which waits for the work to report back, does not see that result.
 */
function runningLine(running) {
    if (running === 0) {
        return '';
    }
    return running === 1
        ? 'A background task you started still runs: say in the handover what its result still needs; the fresh start waits until it reports back. '
        : `${running} background tasks you started still run: say in the handover what each result still needs; the fresh start waits until they report back. `;
}
/**
 * The headings a handover must have for a turn end to take it as ready with no `refresh --ready` call (T2533): what
 * stands, and what comes next. A heading of any level counts when its text starts with the name, so `## Next steps,
 * in this order` does. A handover without one is asked to be fixed once (`takenHandover`), so the fresh start never
 * starts from a handover that lost its state or its next steps.
 */
export const HANDOVER_SECTIONS = ['State', 'Next steps'];
const HEADING = /^#{1,6}[ \t]+(.*)$/;
/** The `HANDOVER_SECTIONS` that `handover` has no heading for, in their order. */
export function missingSections(handover) {
    const headings = handover.split(/\r?\n/).flatMap((line) => {
        const text = HEADING.exec(line.trim())?.[1];
        return text === undefined ? [] : [text.trim().toLowerCase()];
    });
    return HANDOVER_SECTIONS.filter((section) => {
        const name = section.toLowerCase();
        // The name as a whole word: `## Statement` is no `State` section.
        return !headings.some((heading) => heading.startsWith(name) && !/^[\p{L}\p{N}]/u.test(heading.slice(name.length)));
    });
}
/** The sections as the ask and the fix name them: `## State` and `## Next steps`. */
function sectionsText(sections) {
    return sections.map((section) => `\`## ${section}\``).join(' and ');
}
/**
 * The ask to write the handover. It asks only for what the register lacks: the fresh start lists the session's
 * tasks live from the register (hooks/live-tasks.ts), so a status restated here could only go stale. What it asks
 * for goes in the two `HANDOVER_SECTIONS`, so the turn end can take the handover as ready by itself (T2533): the
 * `refresh --ready` call it once asked for re-read the whole context for one line. Within a turn it ends the turn,
 * since the fresh start comes only once the turn has ended. It never waits for `running` background work (T1378): a
 * session that runs its queued steps in the background would reach Claude Code's compaction unasked; only the fresh
 * start, which would cut that work off, waits for it.
 */
function handoverAsk(moment, cause, context, running) {
    const why = whyOf(cause, context.settings);
    const after = moment.kind === 'midTurn' ? ': the turn end takes the handover as ready and the fresh start follows it.' : ': the turn end takes the handover as ready. Do not start new work.';
    return (`${context.command}: ${why}${whenOf(moment)}. Write your handover to ${context.handoverPath}, replacing the whole file (your fresh start reads all of it), ` +
        'with what the register lacks, not task statuses, which your fresh start reads live from the register: ' +
        'a `## State` section (where things are; the scratchpad files, plan file and scheduled jobs the next session still needs; questions still open with the user) ' +
        'and a `## Next steps` section (the next step of each task in progress; what to check later, and when). ' +
        `${runningLine(running)}Then end your turn${after}`);
}
/** `state` with its standing ask marked as asked to fix the handover version `fixHash`; a mid-turn ask is the turn end's now. */
function withFixAsked(state, fixHash) {
    if (state.phase === 'asked') {
        return { ...state, midTurn: false, fixHash };
    }
    return state.phase === 'boundary' && state.ask !== null ? { ...state, ask: { ...state.ask, fixHash } } : state;
}
/**
 * A turn end with an ask for the handover standing (T2533): a handover written since the ask (its fingerprint
 * differs), that `refresh --ready` would take and that has both `HANDOVER_SECTIONS`, is taken as ready, announced at
 * once unless the open meeting or running work holds the notice, as after the call. One written since that falls
 * short is asked to be fixed, once per version, naming the gap and the call that still answers the ask. Undefined
 * leaves the turn end to the ask's own rules: no handover written since, a version already asked about, or a fix the
 * meeting holds.
 */
function takenHandover(state, ask, facts, due, context) {
    const { handover } = due;
    const hash = handoverHashOf(handover);
    if (handover === undefined || hash === null || hash === ask.handoverHash || handover.trim() === '') {
        return undefined;
    }
    const ready = decideReady(state, handover, context.handoverPath, context.now, context.settings.handoverMaxBytes);
    // A handover marked ready already is announced by `decideStop` before it gets here.
    if (ready.kind === 'already') {
        return undefined;
    }
    const missing = missingSections(handover);
    const held = meetingHolds(context.settings, facts.meeting, facts.tokens);
    if (ready.kind === 'ready' && missing.length === 0) {
        if (held || due.running > 0) {
            return { kind: 'write', state: ready.state };
        }
        return noticeOf(ready.state, context, context.canRestart ? 'restart' : 'clear');
    }
    if (held || hash === ask.fixHash) {
        return undefined;
    }
    // Only a handover `refresh --ready` would take can be answered by the call instead.
    const [gap, call] = ready.kind === 'ready'
        ? [`${context.handoverPath} has no ${sectionsText(missing)} section`, `, or, if it is complete as it is, run \`${readyCommand(context.command, context.session.id)}\``]
        : [ready.reason, ''];
    return {
        kind: 'block',
        state: withFixAsked(state, hash),
        reason: `${context.command}: your handover is not ready yet: ${gap}. It needs a ${sectionsText(HANDOVER_SECTIONS)} section. Fix it and end your turn${call}.`,
    };
}
/**
 * The Stop hook, at the end of every turn. A turn end with the context at the threshold, or after the lead
 * asked, keeps the session going to write its handover, so a long task refreshes before Claude Code compacts
 * it; a task end (a `boundary`, judged once) also does after enough tasks at a context worth refreshing, and
 * is recorded as judged when none is due. A session that went on after an ask (the user typed, or never typed
 * /clear) is asked again only once its context grew `reaskGrowth` past that ask, or at its next task end. Once
 * the handover is written it tells the user, once, that the session restarts by itself when it can, else that
 * it waits for /clear. While background work the session started still runs, the notice waits for a later stop,
 * since a fresh start would cut that work off; a due refresh asks anyway and names the work (`handoverAsk`). Both
 * wait while an owner meeting the session is in is open (`meetingHolds`). While an ask stands, a handover written
 * since it with both `HANDOVER_SECTIONS` is taken as ready at the turn end, with no `refresh --ready` call
 * (`takenHandover`, T2533), and one that falls short is asked to be fixed once per version. A stop that ends a turn a
 * Stop hook continued asks for nothing else, so the kit never loops; the notice that the handover is written does
 * show there, since that is the turn that wrote it. A turn that ends after a tool result asked within it (`decideMidTurn`),
 * with no handover marked ready, is asked once more, as a due refresh. The facts are read cheapest first: the
 * running work, which takes the transcript's last 8 MiB, only once a refresh or the notice is due.
 */
export function decideStop(state, context, facts) {
    if (!context.settings.enabled) {
        return NONE;
    }
    if (state?.phase === 'ready' && !state.noticed) {
        if (facts === undefined) {
            return MEASURE;
        }
        // A fresh start now would cut the open meeting off: the notice, and so the restart, waits for its end.
        if (meetingHolds(context.settings, facts.meeting, facts.tokens)) {
            return NONE;
        }
        if (facts.due === undefined) {
            return MEASURE;
        }
        // A fresh start now would cut the running work off: the notice waits for a stop after it ends.
        return facts.due.running > 0 ? NONE : noticeOf(state, context, context.canRestart ? 'restart' : 'clear');
    }
    // A handover written since an ask is taken here, the stop after the ask's own block too: the turn that writes it
    // ends on that block (T2533).
    const ask = standingAsk(state);
    if (state !== undefined && ask !== null) {
        if (facts?.due === undefined) {
            return MEASURE;
        }
        const taken = takenHandover(state, ask, facts, facts.due, context);
        if (taken !== undefined) {
            return taken;
        }
    }
    if (context.stopHookActive) {
        return NONE;
    }
    if (facts === undefined) {
        return MEASURE;
    }
    // The window this measure shows sets the threshold: `largeWindowContextTokens` on a large one.
    const large = windowOf(state, context.settings, facts.tokens, undefined);
    const known = recorded(state, large);
    const sized = { ...context, settings: sizedFor(large, context.settings) };
    const held = meetingHolds(context.settings, facts.meeting, facts.tokens);
    if (known?.phase === 'asked' && known.midTurn) {
        return held ? NONE : pendingAsk(known, sized, facts.due);
    }
    const tokens = facts.tokens ?? null;
    const cause = causeOf(known, facts, sized.settings);
    if (cause === undefined) {
        return judged(state, known, context.now, tokens);
    }
    // The open meeting holds the ask: a boundary stays unjudged, so the turn end after the meeting asks.
    if (held) {
        return NONE;
    }
    if (facts.due === undefined) {
        return MEASURE;
    }
    const task = known?.phase === 'boundary' ? known.task : null;
    return {
        kind: 'block',
        state: { phase: 'asked', task, at: context.now, tokens, handoverHash: facts.due.handoverHash, midTurn: false, ...windowField(large) },
        reason: handoverAsk({ kind: 'turnEnd', task }, cause, sized, facts.due.running),
    };
}
/**
 * A turn end that asks nothing: a task end is recorded as judged, and a fresh start's first measure records its
 * baseline, so the size it started at never asks for another refresh. `known` is `state` with the window this
 * measure showed, recorded when it changed. Else nothing is written.
 */
function judged(state, known, now, tokens) {
    const measured = known !== undefined && tokens !== null && unmeasured(known) ? measuredState(known, tokens) : known;
    if (measured?.phase === 'boundary') {
        return {
            kind: 'write',
            state: { phase: 'idle', task: measured.task, at: now, tokens, finished: measured.finished, ...keepBaseline(measured), ...keepWindow(measured) },
        };
    }
    return measured === state || measured === undefined ? NONE : { kind: 'write', state: measured };
}
/**
 * The turn end after a tool result asked within the turn, the handover not marked ready: asked once more, as the
 * Stop hook's own ask. It keeps the first ask's fingerprint, so a handover written since still counts as new.
 */
function pendingAsk(state, context, due) {
    if (due === undefined) {
        return MEASURE;
    }
    return {
        kind: 'block',
        state: { ...state, midTurn: false },
        reason: handoverAsk({ kind: 'turnEnd', task: state.task }, { kind: 'pending', tokens: state.tokens }, context, due.running),
    };
}
/**
 * The plugin's mod, at a tool result of the main conversation: once the context Claude Code reported reaches
 * `askAt` (the threshold, or well past an ask the session went on from), it asks for the handover within the
 * turn, so a long busy turn refreshes before Claude Code compacts it rather than after. Only the size asks here:
 * the lead's request and the task count stay with the turn's end. The open meeting the session is in holds the
 * ask (`meetingHolds`); background work still running does not, and the ask names it. `nextAt` tells the mod the
 * context to look again at, so it calls the CLI only then; a held ask it looks at again a while later. A handover
 * marked ready and not yet announced stays as it is, as at a task end (`boundaryOf`): the tool result of the very
 * `refresh --ready` call can be past `askAt`, and an ask written over it lost the turn end's notice and so the
 * restart (T2425). The mod then looks again only at its recheck, once the notice is out.
 */
export function decideMidTurn(state, context, facts) {
    if (!context.settings.enabled || (state?.phase === 'ready' && !state.noticed)) {
        return { kind: 'none', nextAt: null };
    }
    // The window the mod reports, or this measure shows, sets the threshold: `largeWindowContextTokens` on a large one.
    const large = windowOf(state, context.settings, facts.tokens, facts.window);
    const known = recorded(state, large);
    const settings = sizedFor(large, context.settings);
    if (known !== undefined && unmeasured(known)) {
        // A fresh start's first measure, within its first turn: recorded as its baseline, no ask.
        const measured = measuredState(known, facts.tokens);
        return { kind: 'none', nextAt: askAt(measured, settings), state: measured };
    }
    const nextAt = askAt(known, settings);
    if (facts.tokens < nextAt || meetingHolds(settings, facts.meeting, facts.tokens)) {
        return known === undefined || known === state ? { kind: 'none', nextAt } : { kind: 'none', nextAt, state: known };
    }
    if (facts.due === undefined) {
        return { kind: 'measure' };
    }
    const task = known?.phase === 'boundary' ? known.task : null;
    const asked = { phase: 'asked', task, at: context.now, tokens: facts.tokens, handoverHash: facts.due.handoverHash, midTurn: true, ...windowField(large) };
    const reason = handoverAsk({ kind: 'midTurn' }, { kind: 'size', tokens: facts.tokens }, { ...context, settings }, facts.due.running);
    return { kind: 'ask', state: asked, reason, nextAt: askAt(asked, settings) };
}
/**
 * A compaction Claude Code is about to run on its own (trigger `auto`) on the main conversation: skipped while the
 * session's handover is asked for or written, since the refresh's fresh start replaces it (the /clear once the turn
 * ended and the person at the tab let it go, or the user's), as long as Claude
 * Code's estimate of the context is under `compactCeilingTokens`. Past the ceiling it goes, so a session never runs
 * out of room: a prompt too long for the window, which compacts with the same trigger, is past it too. A ceiling
 * at or past the window (`SMALLEST_MODEL_WINDOW` when not told) would not leave that room, so it skips nothing.
 */
export function decideCompact(state, context, facts) {
    const { enabled, compactCeilingTokens: ceiling } = context.settings;
    const written = state?.phase === 'ready';
    const pending = written || standingAsk(state) !== null;
    const window = facts.window ?? SMALLEST_MODEL_WINDOW;
    if (!enabled || !pending || ceiling === 0 || ceiling >= window || facts.tokens >= ceiling) {
        return GO;
    }
    const handover = written ? 'written' : 'asked for';
    return {
        kind: 'skip',
        reason: `${context.command}: the handover is ${handover} and the fresh start follows this turn, so compaction waits until ${thousands(ceiling)} (now ${thousands(facts.tokens)})`,
    };
}
/** The fingerprint `decideStop` and `decideReady` compare; null for no handover. */
export function handoverHashOf(text) {
    return text === undefined ? null : lineHash(text);
}
/**
 * `refresh --ready`: only after a handover was asked for (the session is in the ask, or a task end since left it
 * standing), and only once the handover
 * exists, is not blank and differs from the file that was there when it asked (the files port has
 * no modification times, so the fingerprint stands for "written since"), and is at most `maxBytes` long (0: no cap),
 * since the fresh start reads all of it.
 */
export function decideReady(state, handover, handoverPath, now, maxBytes) {
    if (state?.phase === 'ready') {
        return { kind: 'already' };
    }
    const ask = standingAsk(state);
    if (ask === null) {
        return {
            kind: 'refused',
            reason: 'no refresh was asked of you: one is asked at a turn end with your context over the threshold, at a task end after enough tasks, ' +
                'or after the lead asked for it',
        };
    }
    if (handover === undefined || handover.trim() === '') {
        return { kind: 'refused', reason: `write your handover to ${handoverPath} first` };
    }
    if (handoverHashOf(handover) === ask.handoverHash) {
        return { kind: 'refused', reason: `${handoverPath} is the handover from before; write this refresh's handover there` };
    }
    const bytes = Buffer.byteLength(handover, 'utf8');
    if (maxBytes > 0 && bytes > maxBytes) {
        return {
            kind: 'refused',
            reason: `${handoverPath} is ${bytes.toLocaleString('en-US')} bytes, over refresh.handoverMaxBytes (${maxBytes.toLocaleString('en-US')}): ` +
                'your fresh start reads all of it. Rewrite it whole, short, with only what your next session needs',
        };
    }
    return {
        kind: 'ready',
        // A task end since the ask is the task the session refreshes after, as the notice and the fresh start say.
        state: {
            phase: 'ready',
            task: state?.phase === 'boundary' ? state.task : ask.task,
            at: now,
            tokens: ask.tokens,
            noticed: false,
            transcript: null,
            claudePid: null,
            ...keepWindow(state),
        },
    };
}
/** Starts that drop the old context; a `compact`, `resume` or `fork` start keeps it, so the handover waits. */
const FRESH_SOURCES = new Set(['clear', 'startup']);
/** Starts after which the context is small again, so the task count starts over: a compaction too. */
const SMALL_SOURCES = new Set([...FRESH_SOURCES, 'compact']);
/**
 * A start that leaves the context small: the task count starts over, a fresh start (a /clear, a new process) waits for
 * its baseline to be measured again and a compaction drops it. The same state when nothing changes.
 */
function smallAgain(state, source) {
    const fresh = FRESH_SOURCES.has(source);
    const baselineSame = fresh ? state.baseline === null : state.baseline === undefined;
    const countSame = state.phase === 'refreshed' || state.finished === 0;
    if (baselineSame && countSame) {
        return state;
    }
    const { baseline: _dropped, ...rest } = state;
    const counted = rest.phase === 'refreshed' ? rest : { ...rest, finished: 0 };
    return fresh ? { ...counted, baseline: null } : counted;
}
/**
 * SessionStart: the first fresh start after the handover was written points the session at it, once, and says
 * that Claude Code keeps no read from before it: an Edit or Write of a file the new session has not read with the
 * Read tool fails, and that was the most common failed call in one team's week (T1380).
 * Any start that leaves the context small (a compaction too) starts the task count over, and forgets the
 * size a refresh the session went on from was asked at, so its next ask comes at the threshold again. A fresh start
 * (the refresh's own, or a /clear by hand) has its first turn end measure its baseline (`smallAgain`).
 */
export function decideStart(state, source, settings, handoverPath, now) {
    if (!settings.enabled || state === undefined || source === undefined) {
        return { kind: 'none' };
    }
    if ((state.phase === 'boundary' || state.phase === 'idle' || state.phase === 'refreshed') && SMALL_SOURCES.has(source)) {
        const reset = smallAgain(state, source);
        return reset === state ? { kind: 'none' } : { kind: 'reset', state: reset };
    }
    if (state.phase === 'ready' && FRESH_SOURCES.has(source)) {
        const after = state.task === null ? 'mid-task' : `after ${state.task}`;
        return {
            kind: 'inject',
            note: `You were refreshed ${after}; read your handover first: ${handoverPath}. Then carry on with its next steps. ` +
                'Read a file with the Read tool before you Edit or Write it: a read by cat or sed, or one before the refresh, does not count.',
            state: { phase: 'refreshed', task: state.task, at: now, baseline: null, ...keepWindow(state) },
        };
    }
    if ((state.phase === 'asked' || state.phase === 'ready') && state.tokens !== null && SMALL_SOURCES.has(source)) {
        return { kind: 'reset', state: { ...state, tokens: null } };
    }
    return { kind: 'none' };
}
/**
 * How long after a /clear took the refresh the background wake still answers to it: the wake runs beside the
 * SessionStart hook that takes it, so a refresh taken earlier belongs to another start.
 */
export const WAKE_WINDOW_MS = 30_000;
/**
 * The prompt that wakes a session /clear just started from its refresh, so it carries on instead of sitting idle
 * until the user types; undefined when this start took no refresh.
 */
export function wakePromptOf(state, handoverPath, now) {
    if (state?.phase !== 'refreshed') {
        return undefined;
    }
    const age = Date.parse(now) - Date.parse(state.at);
    if (!(age >= 0 && age <= WAKE_WINDOW_MS)) {
        return undefined;
    }
    const at = state.task === null ? '' : ` at ${state.task}`;
    return `You were started fresh after your context refresh${at}: read your handover ${handoverPath} now, take over what the SessionStart note lists, then carry on with its next steps.`;
}
