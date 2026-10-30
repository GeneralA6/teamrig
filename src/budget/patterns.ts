import { isNonNegativeInteger, isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import type { ProgramRun } from '../package-guard/programs.ts';
import { TURN_TRIGGERS, type ToolResult, type ToolUse, type TurnTrigger } from './line.ts';
import { runWorkOf, SHELL_DIALECTS, shellRunsOf } from './run-work.ts';
import { CHARS_PER_TOKEN, contextTokens, WEIGHTS, type Usage } from './weights.ts';

/** What one tool call did, as far as the loop patterns care. */
export const TOOL_KINDS = ['edit', 'editTest', 'testFull', 'testTargeted', 'build', 'teamrigCli', 'git', 'read', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
/** A shell call whose first program is one of these, and that does nothing the other kinds count, only reads. */
const SHELL_READS: ReadonlySet<string> = new Set(['cat', 'sed', 'head', 'tail', 'grep', 'rg', 'ls', 'find', 'wc', 'awk', 'cut']);
/** Output cut by a pipe: a failure can fall outside what the pipe keeps. */
const PIPED = /\|\s*(?:tail|head|grep|Select-Object|findstr)\b/;
/** A failing run in the common reporters: node's spec and TAP counts, a failure mark, Jest and Vitest summaries. */
const TEST_FAILED = /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+[1-9]|✖|\bnot ok \d|Tests?:?\s+\d+ failed|FAIL\s/;

/** Re-reading a token from the cache costs this much of a plain input token; the patterns' savings are priced at it. */
const REREAD = WEIGHTS.cacheRead;
/** A call whose context is below this share of the previous call's was compacted: what came before is gone. */
const COMPACTED_BELOW = 0.65;
/**
 * A call that writes at least this many tokens to the cache, and at least this share of its context, is
 * cold: it paid the write price for a context a warm call reads at the cache price (after an idle hour, a
 * compaction or at a session's start).
 */
const COLD_MIN_TOKENS = 20_000;
const COLD_MIN_SHARE = 0.5;

/**
 * A shell call's kind, by the programs it starts and what each does (`runWorkOf`), not by words its arguments
 * quote: an edit (with a test, `editTest`) before a full suite, a targeted test, a build and a teamrig command;
 * else `git` or `read` by its first program.
 */
function shellKind(runs: readonly ProgramRun[]): ToolKind {
  const works = new Set(runs.map(runWorkOf));
  const tests = works.has('testFull') || works.has('testTargeted');
  if (works.has('edit') || works.has('gitPatch')) {
    return tests ? 'editTest' : 'edit';
  }
  if (works.has('testFull')) {
    return 'testFull';
  }
  if (tests) {
    return 'testTargeted';
  }
  if (works.has('build')) {
    return 'build';
  }
  if (works.has('teamrig')) {
    return 'teamrigCli';
  }
  const first = runs[0]?.name;
  if (first === 'git') {
    return 'git';
  }
  return first !== undefined && SHELL_READS.has(first) ? 'read' : 'other';
}

/** What a tool call did, from its tool name and, for a shell, the programs its command line starts. */
export function kindOf(tool: Pick<ToolUse, 'name' | 'command'>): ToolKind {
  if (EDIT_TOOLS.has(tool.name)) {
    return 'edit';
  }
  if (READ_TOOLS.has(tool.name)) {
    return 'read';
  }
  return SHELL_DIALECTS.has(tool.name) ? shellKind(shellRunsOf(tool)) : 'other';
}

function isEdit(kind: ToolKind): boolean {
  return kind === 'edit' || kind === 'editTest';
}

function isTest(kind: ToolKind): boolean {
  return kind === 'testFull' || kind === 'testTargeted' || kind === 'editTest';
}

/** A step that only looks something up: a read, a git query, a register command. */
function isLookup(kind: ToolKind | null): boolean {
  return kind === 'read' || kind === 'git' || kind === 'teamrigCli';
}

/** Whether a run failed: Claude Code marked the result an error, or the output shows a failing test. */
export function testFailed(result: Pick<ToolResult, 'isError' | 'text'>): boolean {
  return result.isError || TEST_FAILED.test(result.text);
}

/**
 * Where the work came from, per day (`teamrig budget --burn`):
 * - `<trigger>Turns`, `<trigger>W`: the turns each `TURN_TRIGGERS` entry started and their calls' W; a
 *   subagent's run counts under `subagent`, and the turn that resumes a compacted session under the turn it compacted.
 * - `coldCalls`, `coldW`: calls that re-wrote most of their context to the cache, and those writes' W.
 * - `compactions`: the times Claude Code compacted a context.
 */
export const BURN_FIELDS = [
  'ownerTurns',
  'ownerW',
  'peerTurns',
  'peerW',
  'notificationTurns',
  'notificationW',
  'scheduledTurns',
  'scheduledW',
  'subagentTurns',
  'subagentW',
  'otherTurns',
  'otherW',
  'coldCalls',
  'coldW',
  'compactions',
] as const;

/**
 * The rule misses a day shows (`teamrig budget --misses`), each next to the chances it had, counted by
 * `MissTracker` (misses.ts):
 * - `missCalls`: the calls read for misses, so a day metered before they were counted is not read as clean.
 * - `workBlocks`, `missNoStart`: work blocks of at least `START_WITHIN_CALLS` calls, and those with no
 *   `teamrig start` in those calls (rule 4).
 * - `followupsNone`, `missFollowupWords`: `teamrig set` to verifying or done with `--followups none`, and
 *   those whose note or evidence names work left (rule 4).
 * - `worktreeRemoves`, `missGitWorktreeRemove`: worktree removals, and those made with a plain
 *   `git worktree remove` instead of `teamrig worktree remove` (rule 16).
 * - `missAdHocFetch`: an npx, `npm exec`, `npm create` or `pnpm dlx` that fetches the package it names.
 * - `heavySteps`, `missHeavyOutside`: test runs and builds, and those not run under `teamrig queue` or `teamrig test`.
 */
export const MISS_FIELDS = [
  'missCalls',
  'workBlocks',
  'missNoStart',
  'followupsNone',
  'missFollowupWords',
  'worktreeRemoves',
  'missGitWorktreeRemove',
  'missAdHocFetch',
  'heavySteps',
  'missHeavyOutside',
] as const;
export type MissField = (typeof MISS_FIELDS)[number];

/**
 * The loop-pattern counters, per day. Each pattern is a call that one message could have saved:
 * - `readChain`: a single lookup right after another single lookup in the same turn; `readChainW` is those calls' W.
 * - `editChain`: a single edit right after another single edit in the same turn; `editChainSavedW` prices
 *   each at a re-read of its context, what merging it into the previous message saves.
 * - `editThenTest`: a test run right after a single-edit call in the same turn, the two could have been one
 *   message; `editTestJoined` counts the calls that already did both.
 * - `rerunFailedPiped`, `rerunFailedFull`, `rerunAfterPass`: a test run again in the same turn with no edit
 *   since the last one, after that run failed with its output piped through a filter, failed in full, or
 *   passed; the `W` fields are the re-runs' own W.
 * - `passRuns`, `passTokens`, `passRentW`: passing test output and its rent, a cache write when it arrives
 *   plus a re-read by every later call until the context is compacted.
 * Then where the work came from (`BURN_FIELDS`, since 0.34.0) and the rule misses (`MISS_FIELDS`, since 0.87.0).
 */
export const PATTERN_FIELDS = [
  'readChain',
  'readChainW',
  'editChain',
  'editChainSavedW',
  'editThenTest',
  'editThenTestSavedW',
  'editTestJoined',
  'rerunFailedPiped',
  'rerunFailedPipedW',
  'rerunFailedFull',
  'rerunFailedFullW',
  'rerunAfterPass',
  'rerunAfterPassW',
  'passRuns',
  'passTokens',
  'passRentW',
  ...BURN_FIELDS,
  ...MISS_FIELDS,
] as const;
export type PatternField = (typeof PATTERN_FIELDS)[number];
export type PatternCounts = Readonly<Record<PatternField, number>>;

/** Adds to one counter of the day the event belongs to. */
export type Count = (field: PatternField, amount: number) => void;

const ZERO_COUNTS: PatternCounts = {
  readChain: 0,
  readChainW: 0,
  editChain: 0,
  editChainSavedW: 0,
  editThenTest: 0,
  editThenTestSavedW: 0,
  editTestJoined: 0,
  rerunFailedPiped: 0,
  rerunFailedPipedW: 0,
  rerunFailedFull: 0,
  rerunFailedFullW: 0,
  rerunAfterPass: 0,
  rerunAfterPassW: 0,
  passRuns: 0,
  passTokens: 0,
  passRentW: 0,
  ownerTurns: 0,
  ownerW: 0,
  peerTurns: 0,
  peerW: 0,
  notificationTurns: 0,
  notificationW: 0,
  scheduledTurns: 0,
  scheduledW: 0,
  subagentTurns: 0,
  subagentW: 0,
  otherTurns: 0,
  otherW: 0,
  coldCalls: 0,
  coldW: 0,
  compactions: 0,
  missCalls: 0,
  workBlocks: 0,
  missNoStart: 0,
  followupsNone: 0,
  missFollowupWords: 0,
  worktreeRemoves: 0,
  missGitWorktreeRemove: 0,
  missAdHocFetch: 0,
  heavySteps: 0,
  missHeavyOutside: 0,
};

/** Counters a day stored before they were added lacks (`BURN_FIELDS` before 0.34.0, `MISS_FIELDS` before 0.87.0): it reads them as 0. */
const ADDED_LATER: ReadonlySet<PatternField> = new Set([...BURN_FIELDS, ...MISS_FIELDS]);

/** Every counter at 0, as a copy the caller may add to. */
export function emptyPatterns(): Record<PatternField, number> {
  return { ...ZERO_COUNTS };
}

/** One tool call of the call being read, with its run's outcome once the result is in (null until then). */
export interface ToolSummary {
  readonly id: string;
  readonly kind: ToolKind;
  readonly piped: boolean;
  readonly failed: boolean | null;
}

/** The previous call of the thread: its turn, and its tool's kind when it called exactly one. */
export interface PreviousCall {
  readonly turn: number;
  readonly single: ToolKind | null;
}

/**
 * One transcript's pattern state between reads, so reading a file in several runs counts exactly
 * what one pass would. `open` holds the tools of the call still being read: a reply spans several
 * lines, so its patterns are judged only when the next call or turn begins.
 */
export interface PatternState {
  readonly turn: number;
  readonly prev: PreviousCall | null;
  readonly open: readonly ToolSummary[] | null;
  /** The last test run of this turn since the last edit. */
  readonly turnTest: ToolSummary | null;
  /** Passing test output still in the context, in tokens. */
  readonly rentTokens: number;
  readonly lastContext: number;
  /** What started the turn being read. */
  readonly trigger: TurnTrigger;
}

export const INITIAL_PATTERN_STATE: PatternState = { turn: 0, prev: null, open: null, turnTest: null, rentTokens: 0, lastContext: 0, trigger: 'other' };

function summaryOf(tool: ToolUse): ToolSummary {
  return { id: tool.id, kind: kindOf(tool), piped: PIPED.test(tool.command ?? ''), failed: null };
}

/** Counts the loop patterns of one transcript, a line at a time, from the state the last read left. */
export class PatternTracker {
  private current: PatternState;
  /** What one W of this transcript costs in W of a main session: the W worked out here is multiplied by it, the W the meter hands in is weighted already. */
  private readonly weight: number;

  constructor(state: PatternState, weight = 1) {
    this.current = state;
    this.weight = weight;
  }

  state(): PatternState {
    return this.current;
  }

  /**
   * A new turn: chains and re-runs never span two. It counts under what started it; the turn that resumes
   * a compacted session (`continuation`) goes on under the trigger of the turn it compacted.
   */
  prompt(trigger: TurnTrigger | 'continuation', count: Count): void {
    if (trigger !== 'continuation') {
      count(`${trigger}Turns`, 1);
    }
    const next = trigger === 'continuation' ? this.current.trigger : trigger;
    this.current = { ...this.current, turn: this.current.turn + 1, turnTest: null, trigger: next };
  }

  /**
   * A new call begins: it re-reads the passing test output still in the context, unless its context
   * dropped, which means a compaction removed that output. A call that re-wrote most of its context to
   * the cache is counted cold, with the W of those writes.
   */
  callStarted(usage: Usage, tools: readonly ToolUse[], count: Count): void {
    const context = contextTokens(usage);
    const written = usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWriteUnsplit;
    if (written >= COLD_MIN_TOKENS && written >= context * COLD_MIN_SHARE) {
      count('coldCalls', 1);
      const writeW = usage.cacheWrite5m * WEIGHTS.cacheWrite5m + usage.cacheWrite1h * WEIGHTS.cacheWrite1h + usage.cacheWriteUnsplit * WEIGHTS.cacheWriteUnsplit;
      count('coldW', writeW * this.weight);
    }
    const { lastContext, rentTokens } = this.current;
    const compacted = lastContext > 0 && context < lastContext * COMPACTED_BELOW;
    if (!compacted && rentTokens > 0) {
      count('passRentW', rentTokens * REREAD * this.weight);
    }
    this.current = { ...this.current, open: tools.map(summaryOf), rentTokens: compacted ? 0 : rentTokens, lastContext: context };
  }

  /** More tools of the call being read (a later line of the same reply). */
  callJoined(tools: readonly ToolUse[]): void {
    this.current = { ...this.current, open: [...(this.current.open ?? []), ...tools.map(summaryOf)] };
  }

  /**
   * W the meter charged to the call being read, at its start or for output it gained: it goes to the turn's
   * trigger as it is charged, so the triggers' W adds up to the day's W.
   */
  charged(w: number, count: Count): void {
    count(`${this.current.trigger}W`, w);
  }

  /** The call being read is complete: judge its patterns against the previous call of the same turn. */
  callClosed(context: number, w: number, count: Count): void {
    const tools = this.current.open ?? [];
    const { prev, turn } = this.current;
    const sameTurn = prev !== null && prev.turn === turn;
    const single = tools.length === 1 ? (tools[0]?.kind ?? null) : null;
    const edits = tools.some((tool) => isEdit(tool.kind));
    const test = tools.find((tool) => isTest(tool.kind));
    if (edits && test !== undefined) {
      count('editTestJoined', 1);
    }
    if (sameTurn && test !== undefined && !edits && prev.single === 'edit') {
      count('editThenTest', 1);
      count('editThenTestSavedW', context * REREAD * this.weight);
    }
    if (sameTurn && single === 'edit' && prev.single === 'edit') {
      count('editChain', 1);
      count('editChainSavedW', context * REREAD * this.weight);
    }
    if (sameTurn && isLookup(single) && isLookup(prev.single)) {
      count('readChain', 1);
      count('readChainW', w);
    }
    const last = this.current.turnTest;
    if (test !== undefined && !edits && last !== null && last.failed !== null) {
      const field = last.failed === true ? (last.piped ? 'rerunFailedPiped' : 'rerunFailedFull') : 'rerunAfterPass';
      count(field, 1);
      count(`${field}W`, w);
    }
    let turnTest = last;
    if (test !== undefined) {
      turnTest = test;
    } else if (edits) {
      turnTest = null;
    }
    this.current = { ...this.current, prev: { turn, single }, open: null, turnTest };
  }

  /** Tool results came back: a test's outcome is kept for the re-run counters, a passing one's output starts its rent. */
  results(results: readonly ToolResult[], count: Count): void {
    for (const result of results) {
      const open = this.current.open?.find((tool) => tool.id === result.id);
      const tool = open ?? (this.current.turnTest?.id === result.id ? this.current.turnTest : undefined);
      if (tool === undefined || !isTest(tool.kind)) {
        continue;
      }
      const failed = testFailed(result);
      const settled: ToolSummary = { ...tool, failed };
      this.current = {
        ...this.current,
        open: this.current.open?.map((entry) => (entry.id === result.id ? settled : entry)) ?? null,
        turnTest: this.current.turnTest?.id === result.id ? settled : this.current.turnTest,
      };
      if (!failed) {
        const tokens = result.text.length / CHARS_PER_TOKEN;
        count('passRuns', 1);
        count('passTokens', tokens);
        count('passRentW', tokens * WEIGHTS.cacheWrite1h * this.weight);
        this.current = { ...this.current, rentTokens: this.current.rentTokens + tokens };
      }
    }
  }
}

function kindField(record: JsonRecord, key: string): ToolKind | undefined {
  const value = record[key];
  return TOOL_KINDS.find((kind) => kind === value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function summaryFrom(value: unknown): ToolSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, 'id');
  const kind = kindField(value, 'kind');
  const piped = value['piped'];
  const failed = value['failed'];
  if (id === undefined || kind === undefined || typeof piped !== 'boolean' || !(failed === null || typeof failed === 'boolean')) {
    return undefined;
  }
  return { id, kind, piped, failed };
}

function summariesFrom(value: unknown): readonly ToolSummary[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const summaries = value.map(summaryFrom);
  return summaries.every((summary) => summary !== undefined) ? summaries.filter((summary) => summary !== undefined) : undefined;
}

function previousFrom(value: unknown): PreviousCall | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || !isNonNegativeInteger(value['turn'])) {
    return undefined;
  }
  const single = value['single'];
  if (single === null) {
    return { turn: value['turn'], single: null };
  }
  const kind = kindField(value, 'single');
  return kind === undefined ? undefined : { turn: value['turn'], single: kind };
}

/** A stored pattern state; undefined when any part of it is damaged. */
export function parsePatternState(value: unknown): PatternState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { turn, rentTokens, lastContext } = value;
  const prev = previousFrom(value['prev']);
  const open = summariesFrom(value['open']);
  const rawTest = value['turnTest'];
  const turnTest = rawTest === null ? null : summaryFrom(rawTest);
  const rawTrigger = value['trigger'];
  // A state stored before 0.34.0 has no trigger: its open turn counts as other.
  const trigger = rawTrigger === undefined ? 'other' : TURN_TRIGGERS.find((each) => each === rawTrigger);
  if (
    !isNonNegativeInteger(turn) ||
    !finiteNonNegative(rentTokens) ||
    !finiteNonNegative(lastContext) ||
    prev === undefined ||
    open === undefined ||
    turnTest === undefined ||
    trigger === undefined
  ) {
    return undefined;
  }
  return { turn, prev, open, turnTest, rentTokens, lastContext, trigger };
}

/** Stored pattern counters; undefined when one is missing (one added since the day was stored reads as 0) or not a non-negative number. */
export function parsePatternCounts(value: unknown): PatternCounts | undefined {
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) {
    return undefined;
  }
  const counts = emptyPatterns();
  for (const field of PATTERN_FIELDS) {
    const count = record[field];
    if (count === undefined && ADDED_LATER.has(field)) {
      continue;
    }
    if (!finiteNonNegative(count)) {
      return undefined;
    }
    counts[field] = count;
  }
  return counts;
}

