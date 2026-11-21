import { basename, dirname, join } from 'node:path';
import { isRecord, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { ownerTurnsOf } from "./owner-turns.js";
import { REFRESH_FORMAT } from "./state.js";
/**
 * How much of the old transcript is read: enough to reach back past its last compaction, whose cron
 * snapshot the jobs are counted from. A job made before that and never compacted since is missed.
 */
export const CARRY_TAIL_BYTES = 64 * 1024 * 1024;
/** The host ends a recurring session job 7 days after it was made. */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** ScheduleWakeup's shortest delay. */
const WAKE_MIN_SECONDS = 60;
/** Lines that can matter; the rest of a large transcript is never parsed. */
const MARKERS = ['session_cron_carry', '"CronCreate"', '"CronDelete"', '"ScheduleWakeup"', '"humanSchedule"', '"scheduledFor"', '"is_error":true', '"queue-operation"'];
/** The entries the schedule is followed through: the calls, their results, a compaction's snapshot and a queued prompt. */
const KINDS = ['input', 'reply', 'scheduled-carry', 'queued-prompt'];
const ENVIRONMENT = ['environment'];
const SLUG_KEY = '"slug":"';
const SLUG = /^[A-Za-z0-9_-]+$/;
/** The jobs of a carried-jobs file. */
function snapshotOf(tasks) {
    const crons = new Map();
    for (const task of Array.isArray(tasks) ? tasks.filter(isRecord) : []) {
        const id = stringField(task, 'id');
        const cron = stringField(task, 'cron');
        const prompt = stringField(task, 'prompt');
        const createdAt = task['createdAt'];
        if (id !== undefined && cron !== undefined && prompt !== undefined && typeof createdAt === 'number') {
            crons.set(id, { id, cron, prompt, recurring: task['recurring'] !== false, createdAt });
        }
    }
    return crons;
}
/** The session's slug, from the last entry that names one: its plan file is named by it. */
function lastSlugOf(text) {
    const start = text.lastIndexOf(SLUG_KEY);
    if (start < 0) {
        return undefined;
    }
    const from = start + SLUG_KEY.length;
    const slug = text.slice(from, text.indexOf('"', from));
    return SLUG.test(slug) ? slug : undefined;
}
/** Follows a transcript's scheduling calls in order, from its last cron snapshot on. */
class ScheduleFold {
    crons;
    wake;
    wakeCall;
    asks = new Map();
    constructor(inherited) {
        this.crons = new Map(inherited.map((cron) => [cron.id, cron]));
    }
    entry(entry) {
        switch (entry.kind) {
            case 'scheduled-carry':
                // The jobs live in the process at a compaction replace what was counted: the session's own and those an earlier session armed.
                this.crons = new Map(entry.jobs.map((job) => [job.id, job]));
                return;
            case 'queued-prompt':
                this.fired(entry.text);
                return;
            case 'reply':
                for (const call of entry.calls) {
                    this.call(call, entry.at);
                }
                return;
            case 'input':
                for (const outcome of entry.results) {
                    this.result(outcome);
                }
                return;
            default:
                return;
        }
    }
    /** A prompt the host queued: a one-shot job or the wake-up with that prompt has fired. */
    fired(content) {
        if (content === undefined) {
            return;
        }
        for (const cron of [...this.crons.values()]) {
            if (!cron.recurring && cron.prompt === content) {
                this.crons.delete(cron.id);
            }
        }
        if (this.wake?.prompt === content) {
            this.wake = undefined;
        }
    }
    /** A scheduling call; `at` is when its reply was written, undefined when the line gives no time. */
    call(call, at) {
        const { id, input } = call;
        if (input === undefined) {
            return;
        }
        switch (call.name) {
            case 'CronCreate': {
                const cron = stringField(input, 'cron');
                const prompt = stringField(input, 'prompt');
                if (cron !== undefined && prompt !== undefined && at !== undefined) {
                    this.asks.set(id, { cron, prompt, recurring: input['recurring'] !== false, at });
                }
                return;
            }
            case 'CronDelete': {
                const job = stringField(input, 'id');
                if (job !== undefined) {
                    this.crons.delete(job);
                }
                return;
            }
            case 'ScheduleWakeup': {
                const prompt = stringField(input, 'prompt');
                const delay = input['delaySeconds'];
                const scheduled = input['stop'] !== true && prompt !== undefined && typeof delay === 'number' && at !== undefined;
                this.wake = scheduled ? { dueAt: at + delay * 1000, prompt } : undefined;
                this.wakeCall = scheduled ? id : undefined;
                return;
            }
            default:
                return;
        }
    }
    /** A call's result: one that failed, or that kept no answer beside its text, scheduled nothing. */
    result(outcome) {
        const useId = outcome.call;
        if (useId === undefined) {
            return;
        }
        const ask = this.asks.get(useId);
        this.asks.delete(useId);
        const kept = outcome.isError ? undefined : outcome.data;
        if (useId === this.wakeCall) {
            // The host clamps the delay; its result says when the wake-up is really due.
            const scheduledFor = kept?.['scheduledFor'];
            if (kept === undefined) {
                this.wake = undefined;
            }
            else if (this.wake !== undefined && typeof scheduledFor === 'number') {
                this.wake = { ...this.wake, dueAt: scheduledFor };
            }
        }
        const job = kept === undefined ? undefined : stringField(kept, 'id');
        if (ask === undefined || kept === undefined || job === undefined) {
            return;
        }
        const recurring = kept['recurring'];
        this.crons.set(job, { id: job, cron: ask.cron, prompt: ask.prompt, recurring: typeof recurring === 'boolean' ? recurring : ask.recurring, createdAt: ask.at });
    }
}
/**
 * What a transcript shows its session still had scheduled at `now`: the jobs it `inherited` (those a /clear left
 * live in its process) or, from its last compaction on, that compaction's snapshot, and the CronCreate calls after
 * them, less those deleted, fired once or past their 7 days, and the last wake-up asked for, if it is still to come.
 */
export function carryOf(reader, text, now, inherited) {
    const fold = new ScheduleFold(inherited);
    for (const line of text.split('\n')) {
        if (!MARKERS.some((marker) => line.includes(marker))) {
            continue;
        }
        const entry = reader.entry(line, KINDS);
        if (entry !== undefined) {
            fold.entry(entry);
        }
    }
    const crons = [...fold.crons.values()].filter((cron) => !cron.recurring || now - cron.createdAt < RECURRING_MAX_AGE_MS);
    const wake = fold.wake !== undefined && fold.wake.dueAt > now ? fold.wake : undefined;
    return { crons, wake, planSlug: lastSlugOf(text) };
}
/**
 * The scratchpad the host last gave the session, from the last entry that tells it of its machine. It can sit
 * under another project folder than the transcript: a session that moved into a worktree keeps its transcript
 * in the new project folder and its scratchpad where it was. A quoted copy in a tool result is no such entry,
 * and a cut first line cannot be read, so neither is taken.
 */
export function toldScratchpadOf(reader, text) {
    let end = text.length;
    while (end > 0) {
        const start = text.lastIndexOf('\n', end - 1) + 1;
        const entry = reader.entry(text.slice(start, end), ENVIRONMENT);
        if (entry?.kind === 'environment' && entry.scratchpad !== undefined) {
            return entry.scratchpad;
        }
        end = start - 1;
    }
    return undefined;
}
/** The scratchpad folder a transcript's own name gives, `<temp>/claude/<project>/<session>/scratchpad`: the guess when its tail names none. */
export function scratchpadOf(transcript, tempDir) {
    return join(tempDir, 'claude', basename(dirname(transcript)), basename(transcript, '.jsonl'), 'scratchpad');
}
/**
 * What the session whose transcript this is leaves for the fresh one, counting the jobs it `inherited`, and with
 * `handoverPath` what the owner typed in it; undefined when the transcript is gone.
 */
export async function readCarry(reader, files, transcript, now, places, inherited, handoverPath) {
    const text = await files.readTail(transcript, CARRY_TAIL_BYTES);
    if (text === undefined) {
        return undefined;
    }
    const found = carryOf(reader, text, now, inherited);
    const scratchpad = toldScratchpadOf(reader, text) ?? scratchpadOf(transcript, places.tempDir);
    const entries = (await files.list(scratchpad)).length;
    const plan = found.planSlug === undefined ? undefined : join(places.claudeDir, 'plans', `${found.planSlug}.md`);
    const planText = plan === undefined ? undefined : await files.read(plan);
    const owner = handoverPath === undefined ? {} : { ownerTurns: ownerTurnsOf(reader, text, handoverPath, [...inherited.map((cron) => cron.prompt)]) };
    return { ...found, scratchpad: entries > 0 ? { path: scratchpad, entries } : undefined, plan: planText === undefined ? undefined : plan, ...owner };
}
/** A carried-jobs file's content; undefined when it is damaged or from another format. */
export function parseCarriedJobs(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== REFRESH_FORMAT || !Array.isArray(record['crons'])) {
        return undefined;
    }
    const transcript = stringField(record, 'transcript');
    return transcript === undefined ? undefined : { transcript, crons: [...snapshotOf(record['crons']).values()] };
}
export function formatCarriedJobs(jobs) {
    return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...jobs });
}
/** A /clear starts the fresh session in the process it cleared; every other fresh start is a new process. */
export function carryStartOf(source) {
    return source === 'clear' ? 'same-process' : 'new-process';
}
/**
 * The lines that tell a fresh session what to take over: its jobs (still scheduled after a /clear, proven
 * on Claude Code 2.1.301 (T398), so made again only in a new process, and then only those CronList does not
 * show, as a durable job comes back by itself), the wake-up to schedule again (its time on the team's clock),
 * and where the old scratchpad and plan are. Empty when there is nothing. What the owner typed goes to its own file.
 */
export function carryLines(carry, now, start, zone) {
    const lines = [];
    if (carry.crons.length > 0 && start === 'same-process') {
        lines.push(`Your old session's ${carry.crons.length} scheduled job(s) are still scheduled, since a /clear keeps the process (CronList shows them): do not make them again.`);
    }
    else if (carry.crons.length > 0) {
        lines.push(`Your old session had ${carry.crons.length} scheduled job(s), which end with its process: run CronList and make each one it does not show again with CronCreate:`);
        for (const cron of carry.crons) {
            lines.push(`- cron ${JSON.stringify(cron.cron)}, recurring ${String(cron.recurring)}, prompt ${JSON.stringify(cron.prompt)}`);
        }
    }
    if (carry.wake !== undefined) {
        const seconds = Math.max(WAKE_MIN_SECONDS, Math.ceil((carry.wake.dueAt - now) / 1000));
        lines.push(`It had a wake-up due at ${zone.clock(new Date(carry.wake.dueAt))}: schedule it again with ScheduleWakeup, delaySeconds ${seconds}, prompt ${JSON.stringify(carry.wake.prompt)}.`);
    }
    if (carry.scratchpad !== undefined) {
        lines.push(`Its scratchpad stays at ${carry.scratchpad.path} (${carry.scratchpad.entries} entries); yours is a new, empty one, so read or copy from the old one what you still need.`);
    }
    if (carry.plan !== undefined) {
        lines.push(`Its plan file: ${carry.plan}.`);
    }
    return lines;
}
