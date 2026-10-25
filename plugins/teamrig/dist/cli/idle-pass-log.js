import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_HOUR, MS_PER_MINUTE } from "../core/time.js";
/**
 * The idle pass as the wake check runs it (T1100), kept pure: at most once every `IDLE_PASS_EVERY_MS` across the
 * team, and its log keeps what changed, and every step once its last pass record is `IDLE_PASS_LOG_EVERY_MS` old, so
 * a day of quiet passes writes one record an hour and a log silent for longer means the pass stopped (T1158). The
 * state file keeps the last pass's time, each session's step kind then and when a pass last logged its steps; a
 * failed pass keeps the kinds and its error, logged once until the error changes. It also keeps the acts a pass started, so the next passes start none on their sessions while
 * they may still run, and the reopened tabs no hook started in that a pass told of, so it tells of each reopen once.
 */
/** The format of the pass's state file this code reads and writes; a file in another format reads as no pass yet. */
export const IDLE_PASS_STATE_FORMAT = 1;
/** The format of the pass log's records. */
export const IDLE_PASS_LOG_FORMAT = 1;
/** How often the wake checks run the pass, across the team. */
export const IDLE_PASS_EVERY_MS = MS_PER_MINUTE;
/** How old the last pass record may grow before a pass that changed nothing logs every step again. */
export const IDLE_PASS_LOG_EVERY_MS = MS_PER_HOUR;
const PASS_KINDS = { close: true, keep: true, reopen: true, later: true, closed: true, away: true };
function isPassKind(value) {
    return typeof value === 'string' && Object.hasOwn(PASS_KINDS, value);
}
function isPendingAct(value) {
    if (!isRecord(value)) {
        return false;
    }
    const { act, at } = value;
    return (act === 'close' || act === 'reopen') && typeof at === 'number' && Number.isFinite(at);
}
/** The pending acts of a state file: none when absent; undefined when one is damaged. */
function pendingOf(value) {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    const known = entries.filter((entry) => isPendingAct(entry[1]));
    return known.length === entries.length ? Object.fromEntries(known) : undefined;
}
function isTime(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** The reopens told of in a state file: none when absent (as in a file from before them); undefined when damaged. */
function toldOf(value) {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value);
    const known = entries.filter((entry) => isTime(entry[1]));
    return known.length === entries.length ? Object.fromEntries(known) : undefined;
}
/** The state file's content; undefined when it is damaged or from another format, which reads as no pass yet. */
export function parseIdlePassState(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== IDLE_PASS_STATE_FORMAT) {
        return undefined;
    }
    const { at, kinds, failed, logged } = record;
    const pending = pendingOf(record['pending']);
    const told = toldOf(record['told']);
    if (!isTime(at) || !isRecord(kinds) || (failed !== undefined && typeof failed !== 'string') || (logged !== undefined && !isTime(logged)) || pending === undefined || told === undefined) {
        return undefined;
    }
    const entries = Object.entries(kinds);
    const known = entries.filter((entry) => isPassKind(entry[1]));
    if (known.length !== entries.length) {
        return undefined;
    }
    return { at, kinds: Object.fromEntries(known), ...(failed === undefined ? {} : { failed }), ...loggedField(logged), ...pendingField(pending), ...toldField(told) };
}
/** When a pass last logged its steps, as a state field: none before the first. */
function loggedField(logged) {
    return logged === undefined ? {} : { logged };
}
/** The pending acts as a state field: none while nothing is pending. */
function pendingField(pending) {
    return pending === undefined || Object.keys(pending).length === 0 ? {} : { pending };
}
/** The reopens told of as a state field: none while no reopen is hookless. */
function toldField(told) {
    return told === undefined || Object.keys(told).length === 0 ? {} : { told };
}
export function formatIdlePassState(state) {
    const pending = Object.fromEntries(Object.entries(state.pending ?? {}).map(([id, { act, at }]) => [id, { act, at }]));
    const told = { ...state.told };
    return toJsonlLine({ [VERSION_FIELD]: IDLE_PASS_STATE_FORMAT, at: state.at, kinds: { ...state.kinds }, ...(state.failed === undefined ? {} : { failed: state.failed }), ...loggedField(state.logged), ...pendingField(pending), ...toldField(told) });
}
/** Whether a wake check runs the pass now: `IDLE_PASS_EVERY_MS` passed since the last, or the clock went back past it. */
export function isPassDue(state, now) {
    return state === undefined || now < state.at || now - state.at >= IDLE_PASS_EVERY_MS;
}
/** How long the pass may go without running before `check` warns the lead (FLEET-STALE): fifteen missed passes. */
export const IDLE_PASS_STALE_MS = 15 * MS_PER_MINUTE;
/**
 * The trouble of a pass that is on; none while it ran within `IDLE_PASS_STALE_MS` and its last run went through. A
 * failed pass still advances `at`, so its age alone misses it; a clock gone back reads as a pass just run.
 */
export function idlePassTrouble(state, now) {
    if (state === undefined || now - state.at > IDLE_PASS_STALE_MS) {
        return { kind: 'stale', at: state?.at };
    }
    return state.failed === undefined ? undefined : { kind: 'failed', at: state.at, error: state.failed };
}
function minutesAgo(at, now) {
    return `${Math.floor((now - at) / MS_PER_MINUTE)} min ago`;
}
/** `FLEET-STALE the idle pass (open.idle.mode dry-run) last ran 16 min ago: ...`, as `check --all` prints it. */
export function formatIdlePassTrouble(trouble, mode, now) {
    const head = `FLEET-STALE the idle pass (open.idle.mode ${mode})`;
    if (trouble.kind === 'failed') {
        return `${head} failed at its last run, ${minutesAgo(trouble.at, now)}: ${trouble.error}; state/idle-pass.jsonl logs each new failure`;
    }
    const ran = trouble.at === undefined ? 'has not run yet' : `last ran ${minutesAgo(trouble.at, now)}`;
    return `${head} ${ran}: an idle tab's hook wake-check runs it once a minute, so check wake.enabled and that the tabs' teamrig hooks run`;
}
/** The steps whose kind changed since the last pass that ran through; every step at the first. */
export function changedSteps(previous, steps) {
    return steps.filter((step) => previous?.kinds[step.id] !== step.kind);
}
/**
 * The steps a pass logs: every one when no pass logged its steps yet, the last did `IDLE_PASS_LOG_EVERY_MS` ago or
 * more, or the clock went back past it; else only those whose kind changed (`changedSteps`).
 */
export function stepsToLog(previous, steps, now) {
    const logged = previous?.logged;
    return logged === undefined || now < logged || now - logged >= IDLE_PASS_LOG_EVERY_MS ? [...steps] : changedSteps(previous, steps);
}
/**
 * The state after a pass that ran through, with the acts still pending after it, the hookless reopens it found, each
 * told of: a session's mark goes once its tab had a hook, so a later hookless reopen of it is told of again, and when
 * a pass last logged its steps.
 */
export function passedState(now, steps, pending = {}, told = {}, logged) {
    return { at: now, kinds: Object.fromEntries(steps.map((step) => [step.id, step.kind])), ...loggedField(logged), ...pendingField(pending), ...toldField(told) };
}
/**
 * The state after a failed pass: the kinds of the last pass that ran through, so the next one logs its changes since,
 * when a pass last logged its steps, its pending acts, which only a pass that weighs the sessions can let go, and the
 * reopens it told of.
 */
export function failedState(previous, now, error) {
    return { at: now, kinds: previous?.kinds ?? {}, failed: error, ...loggedField(previous?.logged), ...pendingField(previous?.pending), ...toldField(previous?.told) };
}
/** How long a started act holds its session: past any close's or reopen's run, so one that died is started again. */
export const IDLE_ACT_HOLD_MS = 5 * MS_PER_MINUTE;
/** Whether the step still asks for the act: a reopen held back by another's or by the host's room still wants one. */
function stillAsks(step, act) {
    return act === 'close' ? step.kind === 'close' : step.kind === 'reopen' || step.kind === 'later';
}
/**
 * The pending acts this pass keeps: each whose session's step still asks for it, started under `IDLE_ACT_HOLD_MS`
 * ago. One done (the session closed or running), one its act weighed again and kept, and one gone from the roster
 * let go; so does one too old, or started after now (the clock went back), so a dead act is started again.
 */
export function heldActs(pending, steps, now) {
    const stepById = new Map(steps.map((step) => [step.id, step]));
    return Object.fromEntries(Object.entries(pending ?? {}).filter(([id, mark]) => {
        const step = stepById.get(id);
        return step !== undefined && stillAsks(step, mark.act) && now >= mark.at && now - mark.at < IDLE_ACT_HOLD_MS;
    }));
}
/** The acts the pass starts now: each a close or a reopen step asks for, but none while one is pending on its session. */
export function actsToStart(steps, held) {
    return steps.flatMap((step) => {
        if ((step.kind !== 'close' && step.kind !== 'reopen') || Object.hasOwn(held, step.id)) {
            return [];
        }
        return [{ act: step.kind, id: step.id, project: step.project }];
    });
}
/** The commit charge under `key`; nothing where it is unknown. */
function commitField(key, commit) {
    return commit === undefined ? {} : { [key]: { usedMb: commit.usedMb, limitMb: commit.limitMb } };
}
export function formatIdlePassRecord(record) {
    const base = { [VERSION_FIELD]: IDLE_PASS_LOG_FORMAT, at: new Date(record.at).toISOString(), kind: record.kind, mode: record.mode };
    switch (record.kind) {
        case 'failed':
            return toJsonlLine({ ...base, error: record.error });
        case 'act':
            return toJsonlLine({ ...base, act: record.act, id: record.id, outcome: record.outcome, line: record.line, ...commitField('before', record.before), ...commitField('after', record.after) });
        case 'hookless':
            return toJsonlLine({ ...base, id: record.id, line: record.line, ...(record.problem === undefined ? {} : { problem: record.problem }) });
        case 'pass':
            return toJsonlLine({ ...base, ...commitField('commit', record.commit), steps: record.steps.map((step) => ({ kind: step.kind, id: step.id, line: step.line })) });
    }
}
