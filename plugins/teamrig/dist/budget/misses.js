import { isNonNegativeInteger, isRecord } from "../core/guards.js";
import { parseUtcDay } from "../core/time.js";
import { heavyStepOf } from "../package-guard/heavy-steps.js";
import { afterOptions, wordsOf } from "../package-guard/programs.js";
import { runnerCallOf } from "../package-guard/runners.js";
import { GIT_VALUED, shellRunsOf } from "./run-work.js";
/**
 * The rule misses a transcript shows, counted per day next to the loop patterns (`MISS_FIELDS`). Each one
 * is a command's own words, read with the guards' shell parser, so text that only quotes a command (a
 * commit message, a heredoc written to a file) is never counted.
 */
/**
 * A turn this long after the thread's last line starts a work block: the hour the 1-hour cache keeps a
 * context, so the first call after it is cold.
 */
export const BLOCK_IDLE_MS = 60 * 60 * 1000;
/** A work block's `teamrig start` is due within its first this many calls; a shorter block is not counted. */
export const START_WITHIN_CALLS = 10;
/**
 * The turns that can start a work block: someone asks for work. A notification, a subagent's own prompt
 * or the resume of a compacted session goes on with the work already in hand.
 */
const BLOCK_TRIGGERS = new Set(['owner', 'peer', 'scheduled', 'other']);
/** The task statuses whose `teamrig set` takes `--followups`. */
const FOLLOWUP_STATUSES = new Set(['verifying', 'done']);
/** Words saying a task leaves work behind, which `--followups none` denies. */
const WORK_LEFT = /\b(?:follow[- ]?ups?|to-?do|not (?:yet|built|done|fixed|covered|shipped)|left (?:for|to)|still (?:to|needs?)|next steps?)\b/i;
function isTeamrig(run, ...subcommand) {
    const words = wordsOf(run);
    return run.name === 'teamrig' && subcommand.every((word, index) => words[index] === word);
}
/** The value of `--<name> value` or `--<name>=value`; undefined when the option is not given. */
function optionValue(words, name) {
    const flag = `--${name}`;
    for (const [index, word] of words.entries()) {
        if (word === flag) {
            return words[index + 1];
        }
        if (word.startsWith(`${flag}=`)) {
            return word.slice(flag.length + 1);
        }
    }
    return undefined;
}
function isGitWorktreeRemove(run) {
    const [subcommand, action] = afterOptions(wordsOf(run), GIT_VALUED);
    return run.name === 'git' && subcommand === 'worktree' && action === 'remove';
}
/** A `teamrig set` that closes a task as leaving nothing: `none` if so, `left` when its own words name work left, else undefined. */
function followupsNoneOf(run) {
    const words = wordsOf(run);
    if (!isTeamrig(run, 'set') || !FOLLOWUP_STATUSES.has(optionValue(words, 'status') ?? '') || optionValue(words, 'followups') !== 'none') {
        return undefined;
    }
    const said = [optionValue(words, 'note'), optionValue(words, 'evidence')].join(' ');
    return WORK_LEFT.test(said) ? 'left' : 'none';
}
/** The miss counters one tool call adds to, each at most once, and whether it runs `teamrig start`. */
export function toolMissesOf(tool) {
    const runs = shellRunsOf(tool);
    const counts = [];
    const plainRemove = runs.some(isGitWorktreeRemove);
    if (plainRemove || runs.some((run) => isTeamrig(run, 'worktree', 'remove'))) {
        counts.push('worktreeRemoves');
    }
    if (plainRemove) {
        counts.push('missGitWorktreeRemove');
    }
    const followups = runs.map(followupsNoneOf).filter((each) => each !== undefined);
    if (followups.length > 0) {
        counts.push('followupsNone');
    }
    if (followups.includes('left')) {
        counts.push('missFollowupWords');
    }
    if (runs.some((run) => runnerCallOf(run).kind === 'fetch')) {
        counts.push('missAdHocFetch');
    }
    const heavy = runs.filter((run) => heavyStepOf(run) !== undefined);
    if (heavy.length > 0) {
        counts.push('heavySteps');
        if (heavy.some((run) => !run.runner)) {
            counts.push('missHeavyOutside');
        }
    }
    return { starts: runs.some((run) => isTeamrig(run, 'start')), counts };
}
export const INITIAL_MISS_STATE = { lastAt: 0, block: null };
function blockFrom(value) {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const { day, calls } = value;
    return typeof day === 'string' && parseUtcDay(day) !== undefined && isNonNegativeInteger(calls) ? { day, calls } : undefined;
}
/** A stored miss state; undefined when any part of it is damaged. */
export function parseMissState(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { lastAt } = value;
    const block = blockFrom(value['block']);
    if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0 || block === undefined) {
        return undefined;
    }
    return { lastAt, block };
}
/**
 * Counts one transcript's rule misses, a line at a time, from the state the last read left. A miss counts
 * on the day it happened; a work block's `teamrig start`, judged over its first calls, on the day it began.
 */
export class MissTracker {
    current;
    counterOf;
    constructor(state, counterOf) {
        this.current = state;
        this.counterOf = counterOf;
    }
    state() {
        return this.current;
    }
    /**
     * A new turn. One that asks for work after an idle hour, or as the thread's first line, starts a work
     * block; a block still waiting then is dropped uncounted, being shorter than `START_WITHIN_CALLS`.
     */
    prompt(trigger, at, day) {
        if (at === undefined) {
            return;
        }
        const { lastAt } = this.current;
        const idle = lastAt === 0 || at - lastAt >= BLOCK_IDLE_MS;
        const block = idle && BLOCK_TRIGGERS.has(trigger) && day !== undefined ? { day, calls: 0 } : this.current.block;
        this.current = { lastAt: Math.max(lastAt, at), block };
    }
    /** A new call begins at `at`, on `day`, with its first tools. */
    callStarted(tools, at, day) {
        this.counterOf(day)('missCalls', 1);
        this.current = { ...this.current, lastAt: Math.max(this.current.lastAt, at) };
        this.tools(tools, day, true);
    }
    /** More tools of the call being read, which began on `day`. */
    callJoined(tools, day) {
        this.tools(tools, day, false);
    }
    /** A line with no call of its own, such as tool results: it only moves the thread's last time. */
    seen(at) {
        if (at !== undefined) {
            this.current = { ...this.current, lastAt: Math.max(this.current.lastAt, at) };
        }
    }
    tools(tools, day, newCall) {
        const count = this.counterOf(day);
        let starts = false;
        for (const tool of tools) {
            const misses = toolMissesOf(tool);
            starts ||= misses.starts;
            for (const field of misses.counts) {
                count(field, 1);
            }
        }
        const { block } = this.current;
        if (block === null) {
            return;
        }
        const calls = newCall ? block.calls + 1 : block.calls;
        if (!starts && calls < START_WITHIN_CALLS) {
            this.current = { ...this.current, block: { ...block, calls } };
            return;
        }
        const blockCount = this.counterOf(block.day);
        blockCount('workBlocks', 1);
        if (!starts) {
            blockCount('missNoStart', 1);
        }
        this.current = { ...this.current, block: null };
    }
}
