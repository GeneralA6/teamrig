import { formatUtcDay } from "../core/time.js";
/**
 * The skills scorecard's fold: per UTC day and skill, how often the skill was loaded, what a run of it cost (tool
 * calls, failed and refused results) and how often its procedure ran by hand without it (a missed use). A run starts
 * at a load (a `Skill` call or a typed `/name`) or, without one, at the first call that matches the skill's
 * signature, and ends at the next prompt, unless that is a resumed compaction or a task notification that comes while
 * one of the run's own background steps (a call matching its skill's signature) is running. So a run spans turns only
 * through its own procedure's waits, whether the skill was loaded or not. Each transcript file is one thread, a
 * subagent's too.
 */
/** A signature hit this many tool calls or fewer after a load of the skill is the skill at work, not a missed use. */
export const LOAD_WINDOW_CALLS = 30;
/** Error results that are a guard's or a permission's refusal rather than a failing step. */
export const REFUSAL_PREFIXES = [
    'This session is isolated in the worktree',
    'Permission for this action was denied by the Claude Code auto mode',
    "The user doesn't want to proceed with this tool use",
];
/** Prompts that start new work and so end the thread's open runs; a resumed compaction continues them, and a notification ends those not waiting. */
const RUN_ENDING_TRIGGERS = new Set(['owner', 'peer', 'scheduled', 'subagent', 'other']);
/** A Write or Edit of a file under a `.claude/skills/<name>/` folder edits that skill. */
const SKILL_EDIT_PATH = /[\\/]\.claude[\\/]skills[\\/]([^\\/]+)[\\/]/;
const EDIT_TOOLS = new Set(['Write', 'Edit']);
const TOOL_USE_ERROR = /^\s*<tool_use_error>/;
export const EMPTY_TALLY = { runs: 0, calls: 0, failed: 0, refused: 0 };
export const EMPTY_SKILL_DAY = { loads: 0, skill: EMPTY_TALLY, manual: EMPTY_TALLY, edits: 0 };
/** A cursor for a file first read at `offset`, the first line at or after `since`. */
export function newThread(offset, size, since) {
    return { offset, size, lastAt: since, calls: 0, lastLoad: {}, open: [] };
}
/** True for an error result that a guard or a permission refused, not a step that failed. */
export function isRefusal(text) {
    const message = text.replace(TOOL_USE_ERROR, '').trimStart();
    return REFUSAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}
function withRun(tally, run) {
    return { runs: tally.runs + 1, calls: tally.calls + run.calls, failed: tally.failed + run.failed, refused: tally.refused + run.refused };
}
/** The per-day, per-skill counts a scan adds to. */
export class ScorecardTally {
    byDay;
    constructor(days) {
        this.byDay = Object.fromEntries(Object.entries(days).map(([day, skills]) => [day, { ...skills }]));
    }
    load(day, skill) {
        this.update(day, skill, (current) => ({ ...current, loads: current.loads + 1 }));
    }
    edit(day, skill) {
        this.update(day, skill, (current) => ({ ...current, edits: current.edits + 1 }));
    }
    /** Charges an ended run to the day it started on. */
    close(run) {
        this.update(run.day, run.skill, (current) => run.mode === 'skill' ? { ...current, skill: withRun(current.skill, run) } : { ...current, manual: withRun(current.manual, run) });
    }
    days() {
        return this.byDay;
    }
    update(day, skill, change) {
        const skills = (this.byDay[day] ??= {});
        skills[skill] = change(skills[skill] ?? EMPTY_SKILL_DAY);
    }
}
/** Folds one transcript file's lines, in order, into the tally, continuing from its cursor. */
export class ThreadFold {
    tally;
    skills;
    lastLoad;
    lastAt;
    calls;
    open;
    constructor(cursor, tally, skills) {
        this.tally = tally;
        this.skills = skills;
        this.lastLoad = { ...cursor.lastLoad };
        this.lastAt = cursor.lastAt;
        this.calls = cursor.calls;
        this.open = [...cursor.open];
    }
    /** Counts one line; a line with no readable time counts on the day of the line before it. */
    line(line) {
        this.lastAt = line.at ?? this.lastAt;
        const day = formatUtcDay(new Date(this.lastAt));
        if (line.kind === 'prompt') {
            this.prompt(line, day);
        }
        else if (line.kind === 'call') {
            for (const tool of line.tools) {
                this.tool(tool, day);
            }
        }
        else if (line.kind === 'results') {
            this.results(line.results);
        }
    }
    /** Charges every open run, for a thread that went idle. */
    closeAll() {
        for (const run of this.open) {
            this.tally.close(run);
        }
        this.open = [];
    }
    cursor(offset, size) {
        return { offset, size, lastAt: this.lastAt, calls: this.calls, lastLoad: { ...this.lastLoad }, open: [...this.open] };
    }
    prompt(line, day) {
        if (line.trigger === 'notification') {
            this.notified(line.answers);
        }
        else if (RUN_ENDING_TRIGGERS.has(line.trigger)) {
            this.closeAll();
        }
        for (const command of line.commands) {
            if (this.skills.names.has(command)) {
                this.load(command, day);
            }
        }
    }
    tool(tool, day) {
        this.calls += 1;
        this.open = this.open.map((run) => ({ ...run, calls: run.calls + 1 }));
        if (tool.skill !== undefined) {
            if (this.skills.names.has(tool.skill)) {
                this.load(tool.skill, day);
            }
            return;
        }
        const edited = EDIT_TOOLS.has(tool.name) && tool.path !== undefined ? SKILL_EDIT_PATH.exec(tool.path)?.[1] : undefined;
        if (edited !== undefined && this.skills.names.has(edited)) {
            this.tally.edit(day, edited);
        }
        const haystack = `${tool.name} ${tool.command ?? ''}`;
        const hits = new Set(this.skills.signatures.filter((signature) => signature.patterns.some((pattern) => pattern.test(haystack))).map((signature) => signature.name));
        for (const skill of hits) {
            if (!this.loadedRecently(skill) && !this.isOpen(skill)) {
                this.open.push({ skill, mode: 'manual', day, calls: 1, failed: 0, refused: 0, waitsOn: [] });
            }
        }
        if (tool.background === true) {
            this.open = this.open.map((run) => (hits.has(run.skill) ? { ...run, waitsOn: [...run.waitsOn, tool.id] } : run));
        }
    }
    /**
     * A task notification ends every run with no background step of its own still running. The others go on, no longer
     * waiting on the call it reports on, so a run carries on with the steps after its wait and ends at the next
     * notification unless it started another.
     */
    notified(answers) {
        const kept = [];
        for (const run of this.open) {
            if (run.waitsOn.length === 0) {
                this.tally.close(run);
            }
            else {
                kept.push({ ...run, waitsOn: run.waitsOn.filter((id) => id !== answers) });
            }
        }
        this.open = kept;
    }
    results(results) {
        for (const result of results) {
            if (!result.isError) {
                continue;
            }
            const refused = isRefusal(result.text);
            this.open = this.open.map((run) => (refused ? { ...run, refused: run.refused + 1 } : { ...run, failed: run.failed + 1 }));
        }
    }
    /**
     * A load mid-procedure makes the rest the skill's run, so the hand run so far is dropped, its waits passed on; a
     * reload continues the run.
     */
    load(skill, day) {
        this.tally.load(day, skill);
        this.lastLoad[skill] = this.calls;
        if (this.open.some((run) => run.skill === skill && run.mode === 'skill')) {
            return;
        }
        const waitsOn = this.open.find((run) => run.skill === skill)?.waitsOn ?? [];
        this.open = [...this.open.filter((run) => run.skill !== skill), { skill, mode: 'skill', day, calls: 0, failed: 0, refused: 0, waitsOn }];
    }
    loadedRecently(skill) {
        const at = this.lastLoad[skill];
        return at !== undefined && this.calls - at <= LOAD_WINDOW_CALLS;
    }
    isOpen(skill) {
        return this.open.some((run) => run.skill === skill);
    }
}
