import { isRecord, isStringArray, stringField } from "../core/guards.js";
import { holderText } from "./host-lock.js";
import { isStepKind } from "./process-request.js";
/** The pipeline freezes' file in the delivery folder: one JSON array, written whole under its own lock. */
export const PIPELINE_FREEZES_FILE = 'pipeline-freezes.json';
export const PIPELINE_FREEZES_LOCK_FILE = 'pipeline-freezes.lock';
/** The lock is held for one read and write: it lasts 60 s and is waited for 15 s, as the deploy freezes' lock. */
export const PIPELINE_FREEZES_LOCK_TTL_MS = 60_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 500;
const DAY_MS = 86_400_000;
/** A freeze lasts at most 7 days: a typo'd month or year would otherwise stop every queue for good. */
export const MAX_PIPELINE_FREEZE_MS = 7 * DAY_MS;
/** An ended freeze stays 7 days, so the view can show what held and its id is not reused at once. */
const KEEP_ENDED_MS = 7 * DAY_MS;
/** A start up to a minute in the past is the minute the command was typed in, read as now; an earlier one is refused. */
const PAST_START_GRACE_MS = 60_000;
function kindsOf(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!isStringArray(value)) {
        return false;
    }
    const kinds = value.filter(isStepKind);
    return kinds.length === value.length && kinds.length > 0 ? kinds : false;
}
function freezeOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const [id, session, from, to, reason, at] = ['id', 'session', 'from', 'to', 'reason', 'at'].map((key) => stringField(value, key));
    const kinds = kindsOf(value['kinds']);
    if (id === undefined || session === undefined || from === undefined || to === undefined || reason === undefined || at === undefined || kinds === false) {
        return undefined;
    }
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        return undefined;
    }
    return kinds === undefined ? { id, session, from, to, reason, at } : { id, session, from, to, reason, kinds, at };
}
/**
 * The freezes in the file's text (none when it does not exist); an entry that does not read is skipped. Text that is
 * no JSON array (a file caught mid-write) is unreadable, never "no freezes", so a step is refused rather than run
 * through a freeze.
 */
export function parsePipelineFreezes(text) {
    if (text === undefined) {
        return { kind: 'read', freezes: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: 'unreadable', reason: 'not JSON' };
    }
    if (!Array.isArray(parsed)) {
        return { kind: 'unreadable', reason: 'not a JSON array' };
    }
    return { kind: 'read', freezes: parsed.flatMap((value) => freezeOf(value) ?? []) };
}
/** The first freeze holding a step of `kind` at `nowMs`, or undefined when none does. */
export function holdingFreeze(freezes, nowMs, kind) {
    return freezes.find((freeze) => Date.parse(freeze.from) <= nowMs && nowMs < Date.parse(freeze.to) && (freeze.kinds === undefined || freeze.kinds.includes(kind)));
}
/** The freezes not yet ended at `nowMs`, holding or still to come. */
export function liveFreezes(freezes, nowMs) {
    return freezes.filter((freeze) => nowMs < Date.parse(freeze.to));
}
function kindsText(freeze) {
    return freeze.kinds === undefined ? 'all steps' : freeze.kinds.join(',');
}
/** `F2 2030-01-08 10:00 UTC → 2030-01-08 12:00 UTC, all steps, by po (PC downtime)`: a freeze on `zone`'s clock. */
export function pipelineFreezeText(freeze, zone) {
    return `${freeze.id} ${zone.minute(new Date(freeze.from))} → ${zone.minute(new Date(freeze.to))}, ${kindsText(freeze)}, by ${freeze.session} (${freeze.reason})`;
}
/** Why a step is refused under a freeze: until when, by whom, why, and how it ends early. */
export function frozenReason(freeze, zone) {
    return `the pipeline is frozen until ${zone.minute(new Date(freeze.to))} by ${freeze.session} (${freeze.reason}; ${freeze.id}); no new step starts until then. The lead or the delivery owner ends it early with: teamrig pipeline unfreeze ${freeze.id}`;
}
/**
 * Why a step that is each of `kinds` (a merge whose push deploys is a merge and a deploy) may not start at `nowMs`
 * under the freezes in `text`, the file at `path`, or undefined when none holds it. An unreadable file refuses too,
 * since a step that runs through a freeze cannot be undone.
 */
export function pipelineFrozenRefusal(text, path, nowMs, kinds, zone) {
    const read = parsePipelineFreezes(text);
    if (read.kind === 'unreadable') {
        return `the pipeline freezes in ${path} are unreadable (${read.reason}), so no new step starts until the file reads or is removed`;
    }
    const holding = kinds.flatMap((kind) => holdingFreeze(read.freezes, nowMs, kind) ?? [])[0];
    return holding === undefined ? undefined : frozenReason(holding, zone);
}
/** Text on one line, its runs of whitespace one space, since a freeze's reason is shown in one-line refusals. */
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/** Why the freeze cannot be set whatever the file holds, or undefined when it can; `fromMs` is its start as it will be stored. */
function pipelineFreezeRefusal(request, fromMs, nowMs, scanner) {
    if (request.from.getTime() < nowMs - PAST_START_GRACE_MS) {
        return 'a freeze starts now or later, never in the past';
    }
    const toMs = request.to.getTime();
    if (toMs <= fromMs) {
        return 'a freeze ends after it starts';
    }
    if (toMs - fromMs > MAX_PIPELINE_FREEZE_MS) {
        return `a freeze lasts at most 7 days (asked ${Math.ceil((toMs - fromMs) / 3_600_000)} h)`;
    }
    if (request.kinds !== undefined && request.kinds.length === 0) {
        return 'a freeze names at least one step kind, or none for every kind';
    }
    if (oneLine(request.reason) === '') {
        return 'a freeze says why it holds the pipeline';
    }
    return scanner.refusal('the reason', request.reason);
}
/**
 * Reads the freezes under their lock, drops the ones ended over 7 days ago, applies `change` and writes the file. An
 * unreadable file is left as it is and the change refused, since writing over it would drop the freezes it holds.
 */
async function changePipelineFreezes(ports, places, session, change) {
    const taking = await ports.lock.acquire(session, 'pipeline freezes write', LOCK_WAIT_MS, LOCK_POLL_MS, () => undefined);
    if (taking.kind === 'busy') {
        return { kind: 'busy', reason: `the pipeline freezes are being written (${holderText(taking.holder, ports.zone)}); try again` };
    }
    if (taking.kind === 'withdrawn') {
        return { kind: 'busy', reason: 'its place in line for the pipeline freezes was withdrawn; try again' };
    }
    try {
        const read = parsePipelineFreezes(await ports.files.read(places.pipelineFreezes));
        if (read.kind === 'unreadable') {
            return { kind: 'refused', reason: `${places.pipelineFreezes} is unreadable (${read.reason}), so it is left as it is` };
        }
        const nowMs = ports.clock.now();
        const changed = change(read.freezes.filter((freeze) => Date.parse(freeze.to) > nowMs - KEEP_ENDED_MS), nowMs);
        if (changed.kind === 'refused') {
            return changed;
        }
        await ports.files.write(places.pipelineFreezes, `${JSON.stringify(changed.freezes, null, 2)}\n`);
        return { kind: 'done', value: changed.value };
    }
    finally {
        await ports.lock.release(taking.lock);
    }
}
function nextId(freezes) {
    const numbers = freezes.map((freeze) => Number(/^F(\d+)$/.exec(freeze.id)?.[1] ?? 0));
    return `F${Math.max(0, ...numbers) + 1}`;
}
/** Sets a freeze; a start in the past minute is read as now. */
export async function addPipelineFreeze(ports, places, scanner, request) {
    const nowMs = ports.clock.now();
    const fromMs = Math.max(request.from.getTime(), nowMs);
    const refusal = pipelineFreezeRefusal(request, fromMs, nowMs, scanner);
    if (refusal !== undefined) {
        return { kind: 'refused', reason: refusal };
    }
    return changePipelineFreezes(ports, places, request.session, (kept, writtenMs) => {
        const base = { id: nextId(kept), session: request.session, from: new Date(fromMs).toISOString(), to: request.to.toISOString(), reason: oneLine(request.reason) };
        const at = new Date(writtenMs).toISOString();
        const freeze = request.kinds === undefined ? { ...base, at } : { ...base, kinds: [...request.kinds], at };
        return { kind: 'write', freezes: [...kept, freeze], value: freeze };
    });
}
/**
 * Ends freeze `id`: a holding one ends now, so its record stays for the view, and is returned as ended; one still to
 * come is dropped and returned as it was. Refused when no live freeze has that id.
 */
export async function endPipelineFreeze(ports, places, session, id) {
    return changePipelineFreezes(ports, places, session, (kept, nowMs) => {
        const freeze = liveFreezes(kept, nowMs).find((live) => live.id === id);
        if (freeze === undefined) {
            const live = liveFreezes(kept, nowMs).map((each) => each.id);
            return { kind: 'refused', reason: `no live pipeline freeze is ${id} (live: ${live.length === 0 ? 'none' : live.join(', ')})` };
        }
        const started = Date.parse(freeze.from) <= nowMs;
        const ended = { ...freeze, to: new Date(nowMs).toISOString() };
        const freezes = started ? kept.map((each) => (each.id === id ? ended : each)) : kept.filter((each) => each.id !== id);
        return { kind: 'write', freezes, value: started ? ended : freeze };
    });
}
