import { isNonNegativeInteger, isRecord } from '../core/guards.ts';
import { parseUtcDay } from '../core/time.ts';
import type { ProgramRun } from '../package-guard/programs.ts';
import { EXEC_VALUED, NPM_VALUED, runnerCallOf } from '../package-guard/runners.ts';
import type { ToolUse, TurnTrigger } from './line.ts';
import type { Count, MissField } from './patterns.ts';
import { GIT_VALUED, shellRunsOf } from './run-work.ts';

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
const BLOCK_TRIGGERS: ReadonlySet<TurnTrigger | 'continuation'> = new Set(['owner', 'peer', 'scheduled', 'other']);

/** The task statuses whose `teamrig set` takes `--followups`. */
const FOLLOWUP_STATUSES: ReadonlySet<string> = new Set(['verifying', 'done']);
/** Words saying a task leaves work behind, which `--followups none` denies. */
const WORK_LEFT = /\b(?:follow[- ]?ups?|to-?do|not (?:yet|built|done|fixed|covered|shipped)|left (?:for|to)|still (?:to|needs?)|next steps?)\b/i;
/** Programs that run a test suite or a build themselves. */
const HEAVY_PROGRAMS: ReadonlySet<string> = new Set(['tsc', 'jest', 'vitest']);
/** Package scripts that run a test suite or a build: `npm test`, `npm run build`, `pnpm typecheck`, `npm run test:cli`. */
const HEAVY_SCRIPT = /^(?:test|t|tst|verify|check|coverage|build|typecheck|lint)(?::\S*)?$/;
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);

/** What one tool call shows: whether it runs `teamrig start`, and the miss counters it adds to. */
export interface ToolMisses {
  readonly starts: boolean;
  readonly counts: readonly MissField[];
}

function wordsOf(run: ProgramRun): readonly string[] {
  return run.args.map((word) => word.text);
}

/** The words from the first that is not an option, skipping the value of each option in `valued`. */
function afterOptions(words: readonly string[], valued: ReadonlySet<string>): readonly string[] {
  let index = 0;
  while (index < words.length && (words[index] ?? '').startsWith('-')) {
    index += valued.has(words[index] ?? '') ? 2 : 1;
  }
  return words.slice(index);
}

function isTeamrig(run: ProgramRun, ...subcommand: readonly string[]): boolean {
  const words = wordsOf(run);
  return run.name === 'teamrig' && subcommand.every((word, index) => words[index] === word);
}

/** The value of `--<name> value` or `--<name>=value`; undefined when the option is not given. */
function optionValue(words: readonly string[], name: string): string | undefined {
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

function isGitWorktreeRemove(run: ProgramRun): boolean {
  const [subcommand, action] = afterOptions(wordsOf(run), GIT_VALUED);
  return run.name === 'git' && subcommand === 'worktree' && action === 'remove';
}

/** A `teamrig set` that closes a task as leaving nothing: `none` if so, `left` when its own words name work left, else undefined. */
function followupsNoneOf(run: ProgramRun): 'none' | 'left' | undefined {
  const words = wordsOf(run);
  if (!isTeamrig(run, 'set') || !FOLLOWUP_STATUSES.has(optionValue(words, 'status') ?? '') || optionValue(words, 'followups') !== 'none') {
    return undefined;
  }
  const said = [optionValue(words, 'note'), optionValue(words, 'evidence')].join(' ');
  return WORK_LEFT.test(said) ? 'left' : 'none';
}

/** A test suite or a build: `npm test`, `npm run build`, `node --test`, `tsc`, `npx vitest run`. */
function isHeavyStep(run: ProgramRun): boolean {
  const words = wordsOf(run);
  if (HEAVY_PROGRAMS.has(run.name)) {
    return true;
  }
  if (run.name === 'node') {
    return words.includes('--test');
  }
  if (run.name === 'npx') {
    return HEAVY_PROGRAMS.has(afterOptions(words, EXEC_VALUED)[0] ?? '');
  }
  if (!PACKAGE_MANAGERS.has(run.name)) {
    return false;
  }
  const [command, script] = afterOptions(words, NPM_VALUED);
  const named = command === 'run' || command === 'run-script' ? script : command;
  return HEAVY_SCRIPT.test(named ?? '');
}

/** The miss counters one tool call adds to, each at most once, and whether it runs `teamrig start`. */
export function toolMissesOf(tool: Pick<ToolUse, 'name' | 'command'>): ToolMisses {
  const runs = shellRunsOf(tool);
  const counts: MissField[] = [];
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
  const heavy = runs.filter(isHeavyStep);
  if (heavy.length > 0) {
    counts.push('heavySteps');
    if (heavy.some((run) => !run.runner)) {
      counts.push('missHeavyOutside');
    }
  }
  return { starts: runs.some((run) => isTeamrig(run, 'start')), counts };
}

/** A work block still waiting for its `teamrig start`: the UTC day it began and the calls made in it so far. */
export interface OpenBlock {
  readonly day: string;
  readonly calls: number;
}

/** One transcript's miss state between reads, so reading a file in several runs counts what one pass would. */
export interface MissState {
  /** Epoch ms of the last line read with a time; 0 before the first. */
  readonly lastAt: number;
  readonly block: OpenBlock | null;
  /** True from a work-block start note (budget/line.ts StartNoteLine) until the next prompt, so a block that prompt opens has its start. */
  readonly noted: boolean;
}

export const INITIAL_MISS_STATE: MissState = { lastAt: 0, block: null, noted: false };

function blockFrom(value: unknown): OpenBlock | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { day, calls } = value;
  return typeof day === 'string' && parseUtcDay(day) !== undefined && isNonNegativeInteger(calls) ? { day, calls } : undefined;
}

/** A stored miss state; undefined when any part of it is damaged. A state stored before start notes (T1529) has no note pending. */
export function parseMissState(value: unknown): MissState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { lastAt } = value;
  const block = blockFrom(value['block']);
  const noted = value['noted'] === undefined ? false : value['noted'];
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0 || block === undefined || typeof noted !== 'boolean') {
    return undefined;
  }
  return { lastAt, block, noted };
}

/**
 * Counts one transcript's rule misses, a line at a time, from the state the last read left. A miss counts
 * on the day it happened; a work block's `teamrig start`, judged over its first calls, on the day it began.
 */
export class MissTracker {
  private current: MissState;
  private readonly counterOf: (day: string | undefined) => Count;

  constructor(state: MissState, counterOf: (day: string | undefined) => Count) {
    this.current = state;
    this.counterOf = counterOf;
  }

  state(): MissState {
    return this.current;
  }

  /**
   * A new turn. One that asks for work after an idle hour, or as the thread's first line, starts a work
   * block; a block still waiting then is dropped uncounted, being shorter than `START_WITHIN_CALLS`. A block opened
   * right after a work-block start note has its start already (`startNote`); any turn ends the note's reach.
   */
  prompt(trigger: TurnTrigger | 'continuation', at: number | undefined, day: string | undefined): void {
    if (at === undefined) {
      return;
    }
    const { lastAt, noted } = this.current;
    const seenAt = Math.max(lastAt, at);
    const idle = lastAt === 0 || at - lastAt >= BLOCK_IDLE_MS;
    if (!idle || !BLOCK_TRIGGERS.has(trigger) || day === undefined) {
      this.current = { lastAt: seenAt, block: this.current.block, noted: false };
      return;
    }
    if (noted) {
      this.counterOf(day)('workBlocks', 1);
    }
    this.current = { lastAt: seenAt, block: noted ? null : { day, calls: 0 }, noted: false };
  }

  /**
   * A start note that is the session's work-block start (T1529): it holds what `teamrig start` prints first, so it is
   * the start of the block waiting now, or of the block the next turn opens, as Claude Code writes the note before
   * that turn's prompt. It is no activity of the session's own, so it leaves the thread's last time.
   */
  startNote(): void {
    const { block } = this.current;
    if (block === null) {
      this.current = { ...this.current, noted: true };
      return;
    }
    this.counterOf(block.day)('workBlocks', 1);
    this.current = { ...this.current, block: null, noted: false };
  }

  /** A new call begins at `at`, on `day`, with its first tools. */
  callStarted(tools: readonly ToolUse[], at: number, day: string): void {
    this.counterOf(day)('missCalls', 1);
    this.current = { ...this.current, lastAt: Math.max(this.current.lastAt, at) };
    this.tools(tools, day, true);
  }

  /** More tools of the call being read, which began on `day`. */
  callJoined(tools: readonly ToolUse[], day: string): void {
    this.tools(tools, day, false);
  }

  /** A line with no call of its own, such as tool results: it only moves the thread's last time. */
  seen(at: number | undefined): void {
    if (at !== undefined) {
      this.current = { ...this.current, lastAt: Math.max(this.current.lastAt, at) };
    }
  }

  private tools(tools: readonly ToolUse[], day: string, newCall: boolean): void {
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
