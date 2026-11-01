import { formatUtcDay, formatUtcHour, MS_PER_DAY } from "../core/time.js";
import { findLineAtOrAfter, readLines } from "./cursor.js";
import { parseTranscriptLine } from "./line.js";
import { MissTracker } from "./misses.js";
import { emptyPatterns, PatternTracker } from "./patterns.js";
import { newCursor, pruneUsage, RECENT_KEYS_KEPT, } from "./store.js";
import { NO_TURN, TurnTasks } from "./tasks.js";
import { contextTokens, WEIGHTS, weightOf } from "./weights.js";
/**
 * Totals while a run counts: per-day sums, W per hour and per task, and the latest call keys across all the
 * session's transcripts, so a call two files both logged counts once.
 */
class Tally {
    days = new Map();
    hours;
    tasks;
    keys;
    keySet;
    constructor(state) {
        for (const [day, usage] of Object.entries(state.byDay)) {
            this.days.set(day, { w: usage.w, calls: usage.calls, patterns: { ...usage.patterns } });
        }
        this.hours = new Map(Object.entries(state.byHour));
        this.tasks = new Map(Object.entries(state.byTask).map(([day, tasks]) => [day, new Map(Object.entries(tasks))]));
        this.keys = [...state.recentKeys];
        this.keySet = new Set(this.keys);
    }
    day(day) {
        const found = this.days.get(day);
        if (found !== undefined) {
            return found;
        }
        const created = { w: 0, calls: 0, patterns: emptyPatterns() };
        this.days.set(day, created);
        return created;
    }
    /** Adds `w` to an hour's W; an hour unknown (a call stored before hours were counted) adds nothing. */
    addHour(hour, w) {
        if (hour !== null) {
            this.hours.set(hour, (this.hours.get(hour) ?? 0) + w);
        }
    }
    /** Adds `w` of `day` to a task. */
    chargeTask(day, task, w) {
        const tasks = this.tasks.get(day) ?? new Map();
        tasks.set(task, (tasks.get(task) ?? 0) + w);
        this.tasks.set(day, tasks);
    }
    counter(day) {
        if (day === undefined) {
            return () => undefined;
        }
        const totals = this.day(day);
        return (field, amount) => {
            totals.patterns[field] += amount;
        };
    }
    /** True when the key was seen recently; else it is remembered, the oldest key falling out past the limit. */
    seen(key) {
        if (this.keySet.has(key)) {
            return true;
        }
        this.keys.push(key);
        this.keySet.add(key);
        if (this.keys.length > RECENT_KEYS_KEPT) {
            const oldest = this.keys.shift();
            if (oldest !== undefined) {
                this.keySet.delete(oldest);
            }
        }
        return false;
    }
    byDay() {
        return Object.fromEntries([...this.days].map(([day, totals]) => [day, { w: totals.w, calls: totals.calls, patterns: { ...totals.patterns } }]));
    }
    byHour() {
        return Object.fromEntries(this.hours);
    }
    byTask() {
        return Object.fromEntries([...this.tasks].map(([day, tasks]) => [day, Object.fromEntries(tasks)]));
    }
    recentKeys() {
        return [...this.keys];
    }
}
function dayOf(at) {
    return formatUtcDay(new Date(at));
}
/**
 * Counts one transcript's new lines into the tally. A reply is several lines sharing its key, each
 * repeating the usage with the output so far: the first line counts the call, a later one only the
 * output it adds. A call whose key was seen in the last few hundred calls was logged twice and is
 * skipped; a call without a timestamp is skipped, as no day can take it. Every W is multiplied by the
 * transcript's weight, so a subagent's counts in W of a main session. The rule misses of each call's
 * shell commands are counted alongside (`MissTracker`), on the same days. In the session's own transcripts
 * each turn's W goes to the tasks its calls name (`TurnTasks`); a subagent's W goes to no task.
 */
class TranscriptFold {
    call;
    tracker;
    misses;
    turn;
    tally;
    weight;
    constructor(cursor, tally, transcript) {
        this.call = cursor.call;
        this.tracker = new PatternTracker(cursor.patterns, transcript.weight);
        this.misses = new MissTracker(cursor.misses, (day) => tally.counter(day));
        this.turn = transcript.own ? new TurnTasks(cursor.turn, (day, task, w) => tally.chargeTask(day, task, w)) : undefined;
        this.tally = tally;
        this.weight = transcript.weight;
    }
    line(raw) {
        const line = parseTranscriptLine(raw);
        if (line === undefined) {
            return;
        }
        const lineDay = line.at === undefined ? undefined : dayOf(line.at);
        if (line.kind === 'prompt') {
            this.close();
            this.turn?.prompt();
            this.tracker.prompt(line.trigger, this.tally.counter(lineDay));
            this.misses.prompt(line.trigger, line.at, lineDay);
        }
        else if (line.kind === 'compact') {
            this.tally.counter(lineDay)('compactions', 1);
        }
        else if (line.kind === 'start-note') {
            this.misses.startNote();
        }
        else if (line.kind === 'results') {
            this.tracker.results(line.results, this.tally.counter(this.call?.day ?? lineDay));
            this.misses.seen(line.at);
        }
        else {
            this.reply(line);
        }
    }
    cursor(offset, size, day) {
        return { offset, size, day, call: this.call, patterns: this.tracker.state(), misses: this.misses.state(), turn: this.turn?.state() ?? NO_TURN };
    }
    reply(line) {
        const open = this.call;
        if (open !== null && line.key !== undefined && line.key === open.key) {
            const added = Math.max(0, line.usage.output - open.output) * WEIGHTS.output * this.weight;
            this.turn?.named(line.tools);
            this.turn?.charged(open.day, added);
            this.tally.day(open.day).w += added;
            this.tally.addHour(open.hour, added);
            this.tracker.charged(added, this.tally.counter(open.day));
            this.call = { ...open, output: Math.max(open.output, line.usage.output), w: open.w + added };
            this.tracker.callJoined(line.tools);
            this.misses.callJoined(line.tools, open.day);
            return;
        }
        this.close();
        if (line.at === undefined || (line.key !== undefined && this.tally.seen(line.key))) {
            return;
        }
        const day = dayOf(line.at);
        const hour = formatUtcHour(new Date(line.at));
        const w = weightOf(line.usage) * this.weight;
        const context = contextTokens(line.usage);
        const totals = this.tally.day(day);
        totals.w += w;
        totals.calls += 1;
        this.tally.addHour(hour, w);
        this.turn?.named(line.tools);
        this.turn?.charged(day, w);
        this.tracker.charged(w, this.tally.counter(day));
        this.tracker.callStarted(line.usage, line.tools, this.tally.counter(day));
        this.misses.callStarted(line.tools, line.at, day);
        this.call = { key: line.key ?? null, day, hour, output: line.usage.output, context, w };
    }
    /** The open call is complete: its loop patterns are judged now, against the call before it. */
    close() {
        const open = this.call;
        if (open === null) {
            return;
        }
        this.tracker.callClosed(open.context, open.w, this.tally.counter(open.day));
        this.call = null;
    }
}
/**
 * Counts a session's API use from its transcripts since the last run, as weighted tokens per UTC day and
 * hour and per task, calls, loop patterns and rule misses, and saves the totals with each transcript's read position. A transcript
 * seen for the first time (or that shrank, so it was replaced) is read from today's first line, found
 * by a binary search. One run reads at most `maxBytes`; the rest waits for the next run. A subagent's W
 * is multiplied by `subagentWeight`.
 */
export async function runMeter(deps, run) {
    const { rev, state } = await deps.store.load(run.session);
    const now = deps.clock.now();
    const today = dayOf(now);
    const todayStart = now - (now % MS_PER_DAY);
    const tally = new Tally(state);
    const cursors = { ...state.cursors };
    let budget = run.maxBytes;
    let bytesRead = 0;
    let catchingUp = false;
    const weighted = [
        ...run.transcripts.main.map((path) => ({ path, weight: 1, own: true })),
        ...run.transcripts.subagents.map((path) => ({ path, weight: run.subagentWeight, own: false })),
    ];
    for (const transcript of weighted) {
        const { path } = transcript;
        const size = await deps.bytes.size(path);
        if (size === undefined) {
            continue;
        }
        const stored = cursors[path];
        const cursor = stored !== undefined && stored.offset <= size ? stored : newCursor(await findLineAtOrAfter(deps.bytes, path, size, todayStart), size, today);
        if (cursor.offset === size) {
            cursors[path] = { ...cursor, size };
            continue;
        }
        if (budget <= 0) {
            catchingUp = true;
            cursors[path] = cursor;
            continue;
        }
        const batch = await readLines(deps.bytes, path, cursor.offset, size, budget);
        budget -= batch.bytes;
        bytesRead += batch.bytes;
        catchingUp ||= batch.capped;
        const fold = new TranscriptFold(cursor, tally, transcript);
        for (const line of batch.lines) {
            fold.line(line);
        }
        cursors[path] = fold.cursor(batch.end, size, batch.end > cursor.offset ? today : cursor.day);
    }
    const next = pruneUsage({ byDay: tally.byDay(), byHour: tally.byHour(), byTask: tally.byTask(), cursors, recentKeys: tally.recentKeys() }, now);
    const saved = await deps.store.save(run.session, next, rev);
    return { state: next, saved, catchingUp, bytesRead };
}
