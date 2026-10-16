import { lineHash } from "../inbox/line-hash.js";
const NONE = { kind: 'none' };
const MEASURE = { kind: 'measure' };
/** Tokens as people say them: 262,144 is `262k`. */
export function thousands(tokens) {
    return `${Math.round(tokens / 1000)}k`;
}
/** The notice that `state`'s handover is written: the restart to come when `restart`, else the /clear to type. */
export function noticeOf(state, context, restart) {
    const { name } = context.session;
    const next = restart
        ? `${context.command} starts it fresh once it has been idle ${context.settings.restartDelaySeconds} s (type anything to keep this context)`
        : 'type /clear for a fresh start';
    return {
        kind: 'notice',
        state: { ...state, noticed: true },
        message: `${context.command}: ${name} finished ${state.task} and wrote its handover; ${next}`,
        title: context.settings.tabTitle ? `${name}: ${restart ? 'restarting' : 'type /clear'}` : undefined,
        restart,
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
/** `set <id> --status done`: the boundary the Stop hook judges, counting this task. */
export function boundaryOf(previous, task, at) {
    return { phase: 'boundary', task, at, finished: finishedSoFar(previous) + 1 };
}
function causeOf(facts, settings, finished) {
    if (facts.requestedBy !== undefined) {
        return { kind: 'asked', by: facts.requestedBy, tokens: facts.tokens ?? null };
    }
    const { tokens } = facts;
    if (tokens === undefined) {
        return undefined;
    }
    if (tokens >= settings.contextTokens) {
        return { kind: 'size', tokens };
    }
    const counted = settings.everyTasks > 0 && finished >= settings.everyTasks && tokens >= settings.everyTasksMinTokens;
    return counted ? { kind: 'tasks', tokens, finished } : undefined;
}
function whyOf(cause, settings) {
    switch (cause.kind) {
        case 'size':
            return `your context is ${thousands(cause.tokens)} (refresh at ${thousands(settings.contextTokens)})`;
        case 'tasks':
            return `your context is ${thousands(cause.tokens)} after ${cause.finished} tasks (refresh every ${settings.everyTasks} tasks)`;
        case 'asked':
            return `${cause.by} asked for a refresh${cause.tokens === null ? '' : ` (your context is ${thousands(cause.tokens)})`}`;
    }
}
function handoverAsk(task, cause, context) {
    const why = whyOf(cause, context.settings);
    return (`${context.command}: ${why} and you just finished ${task}. Write your handover to ${context.handoverPath} ` +
        '(what is in progress, the next step of each, open questions, where things are), then run ' +
        `\`${readyCommand(context.command, context.session.id)}\`. Do not start new work.`);
}
/**
 * The Stop hook, at the end of every turn. Only a boundary (a task just finished) is judged, once:
 * at or over the threshold, after enough tasks at a context worth refreshing, or when the lead asked,
 * the session is kept going to write its handover;
 * otherwise the boundary is recorded as judged and nothing is said. Once the handover is written it
 * tells the user, once, that the session restarts by itself when it can, else that it waits for /clear.
 * While background work the session started still runs, a due refresh and the notice wait for a later
 * stop, since a fresh start would cut that work off. A stop that ends a turn a Stop hook continued never judges a boundary, so
 * the kit never loops; the notice that the handover is written does show there, since that is the
 * turn that runs `refresh --ready`.
 */
export function decideStop(state, context, facts) {
    if (state === undefined || !context.settings.enabled) {
        return NONE;
    }
    if (state.phase === 'ready') {
        if (state.noticed) {
            return NONE;
        }
        if (facts === undefined) {
            return MEASURE;
        }
        // A fresh start now would cut the running work off: the notice waits for a stop after it ends.
        if (facts.running > 0) {
            return NONE;
        }
        return noticeOf(state, context, context.canRestart);
    }
    if (state.phase !== 'boundary' || context.stopHookActive) {
        return NONE;
    }
    if (facts === undefined) {
        return MEASURE;
    }
    const tokens = facts.tokens ?? null;
    const cause = causeOf(facts, context.settings, state.finished);
    if (cause === undefined) {
        return { kind: 'write', state: { phase: 'idle', task: state.task, at: context.now, tokens, finished: state.finished } };
    }
    // A refresh would cut the running work off: the boundary stays unjudged, so a stop after the work ends judges it.
    if (facts.running > 0) {
        return NONE;
    }
    return {
        kind: 'block',
        state: { phase: 'asked', task: state.task, at: context.now, tokens, handoverHash: facts.handoverHash },
        reason: handoverAsk(state.task, cause, context),
    };
}
/** The fingerprint `decideStop` and `decideReady` compare; null for no handover. */
export function handoverHashOf(text) {
    return text === undefined ? null : lineHash(text);
}
/**
 * `refresh --ready`: only after the Stop hook asked for a handover, and only once the handover
 * exists, is not blank and differs from the file that was there when it asked (the files port has
 * no modification times, so the fingerprint stands for "written since").
 */
export function decideReady(state, handover, handoverPath, now) {
    if (state?.phase === 'ready') {
        return { kind: 'already' };
    }
    if (state?.phase !== 'asked') {
        return {
            kind: 'refused',
            reason: 'no refresh was asked of you: one is asked when you finish a task with your context over the threshold, or after the lead asked for it',
        };
    }
    if (handover === undefined || handover.trim() === '') {
        return { kind: 'refused', reason: `write your handover to ${handoverPath} first` };
    }
    if (handoverHashOf(handover) === state.handoverHash) {
        return { kind: 'refused', reason: `${handoverPath} is the handover from before; write this refresh's handover there` };
    }
    return { kind: 'ready', state: { phase: 'ready', task: state.task, at: now, noticed: false } };
}
/** Starts that drop the old context; a `compact`, `resume` or `fork` start keeps it, so the handover waits. */
const FRESH_SOURCES = new Set(['clear', 'startup']);
/** Starts after which the context is small again, so the task count starts over: a compaction too. */
const SMALL_SOURCES = new Set([...FRESH_SOURCES, 'compact']);
/**
 * SessionStart: the first fresh start after the handover was written points the session at it, once.
 * Any start that leaves the context small (a compaction too) starts the task count over.
 */
export function decideStart(state, source, settings, handoverPath, now) {
    if (!settings.enabled || state === undefined || source === undefined) {
        return { kind: 'none' };
    }
    if ((state.phase === 'boundary' || state.phase === 'idle') && state.finished > 0 && SMALL_SOURCES.has(source)) {
        return { kind: 'reset', state: { ...state, finished: 0 } };
    }
    if (state.phase !== 'ready' || !FRESH_SOURCES.has(source)) {
        return { kind: 'none' };
    }
    return {
        kind: 'inject',
        note: `You were refreshed after ${state.task}; read your handover first: ${handoverPath}`,
        state: { phase: 'refreshed', task: state.task, at: now },
    };
}
