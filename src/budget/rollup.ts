import { formatUtcDay } from '../core/time.ts';
import { parseTranscriptLine, stopFeedbackPromptOf, type CallLine, type ToolUse, type TranscriptLine } from './line.ts';
import type { DayRollup, TaskRow, UseClass, UseRow } from './rollup-file.ts';
import { TASKS_PER_TURN, tasksNamedBy } from './tasks.ts';
import { isCoordinationTool } from './use-class.ts';
import { WEIGHTS, weightOf } from './weights.ts';

/**
 * The fold of a team's transcripts into rows per UTC day, by T1995's classes: what keeps the team running against what
 * does its work. W here is raw, with no `budget.subagentWeight`, so a reader can apply whichever weight it needs.
 */

/** The classes that do a task's work, so the only ones charged to a task: coordination stays its own class (T2077). */
const TASK_WORK_CLASSES: ReadonlySet<UseClass> = new Set<UseClass>(['work', 'lead-work', 'helper']);
/** The longest time one call is charged: a foreground Bash call stops at 10 minutes, so a longer gap is an idle session. */
const MAX_CALL_MS = 600_000;

/** Whose transcript a fold reads. */
export interface RollupSource {
  readonly session: string;
  /** The session is a team's lead, whose calls split by call: its turns are never a coordination-turn. */
  readonly lead: boolean;
  /** A helper's own transcript. */
  readonly side: boolean;
}

/** One line of a transcript as the rollup reads it: the meter's lines, and the Stop hook's push that starts a turn here only. */
export function parseRollupLine(raw: string): TranscriptLine | undefined {
  return parseTranscriptLine(raw) ?? stopFeedbackPromptOf(raw);
}

/** A reply while its turn is open. A reply's lines repeat its usage, so the first gives the W and later ones only what they add. */
interface HeldCall {
  readonly key: string | undefined;
  readonly at: number;
  readonly model: string | null;
  readonly effort: string | null;
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  output: number;
  w: number;
  readonly tools: ToolUse[];
}

function heldCallOf(line: CallLine, at: number): HeldCall {
  const { usage } = line;
  return {
    key: line.key,
    at,
    model: line.model ?? null,
    effort: line.effort ?? null,
    input: usage.input,
    cacheWrite: usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWriteUnsplit,
    cacheRead: usage.cacheRead,
    output: usage.output,
    w: weightOf(usage),
    tools: [...line.tools],
  };
}

/** Each call's coordination, in order: a call with no tool takes the one before it, and a turn starts as coordination. */
function coordinationOf(calls: readonly HeldCall[]): readonly boolean[] {
  let previous = true;
  return calls.map((call) => {
    previous = call.tools.length === 0 ? previous : call.tools.every(isCoordinationTool);
    return previous;
  });
}

/** What started a turn: nothing for the calls before a transcript's first prompt. */
interface TurnStart {
  readonly at: number | undefined;
  readonly pushed: boolean;
}

/** Each call's class. A call before any prompt answers nothing the rollup can read, so it is work, a lead's too. */
function classesOf(calls: readonly HeldCall[], source: RollupSource, start: TurnStart | undefined): readonly UseClass[] {
  if (source.side) {
    return calls.map(() => 'helper');
  }
  const coordination = start === undefined ? calls.map(() => false) : coordinationOf(calls);
  if (source.lead) {
    return coordination.map((call) => (call ? 'lead-coordination' : 'lead-work'));
  }
  if (start?.pushed === true && coordination.every(Boolean)) {
    return calls.map(() => 'coordination-turn');
  }
  return coordination.map((call) => (call ? 'coordination-call' : 'work'));
}

function spanMs(from: number, to: number): number {
  return Math.min(MAX_CALL_MS, Math.max(0, to - from));
}

/** Each call's active seconds: its start to the next call's, so a test's wait goes to the call that ran it, and the first also from its prompt. */
function secondsOf(calls: readonly HeldCall[], source: RollupSource, start: TurnStart | undefined): readonly number[] {
  return calls.map((call, index) => {
    const next = calls[index + 1];
    const own = next === undefined ? 0 : spanMs(call.at, next.at);
    const opening = index === 0 && start?.at !== undefined ? spanMs(start.at, call.at) : 0;
    return source.side ? 0 : Math.round((own + opening) / 1000);
  });
}

/** `total` over `parts` shares in whole numbers that add up to it, the remainder on the first. */
function evenShares(total: number, parts: number): readonly number[] {
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < extra ? 1 : 0));
}

/** The tasks a turn's calls name, in order and once each, at most `TASKS_PER_TURN` as the meter holds them. */
function turnTasksOf(calls: readonly HeldCall[]): readonly string[] {
  return [...new Set(calls.flatMap((call) => tasksNamedBy(call.tools)))].slice(0, TASKS_PER_TURN);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function compareText(a: string | null, b: string | null): number {
  const left = a ?? '';
  const right = b ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRows(a: UseRow, b: UseRow): number {
  return compareText(a.session, b.session) || compareText(a.useClass, b.useClass) || compareText(a.model, b.model) || compareText(a.effort, b.effort);
}

function compareTasks(a: TaskRow, b: TaskRow): number {
  return compareText(a.session, b.session) || compareText(a.task, b.task);
}

/** One day's rows while a run adds to them. */
class DayTally {
  private readonly rows = new Map<string, Mutable<UseRow>>();
  private readonly tasks = new Map<string, Mutable<TaskRow>>();

  /** A call's use, with its W and seconds as whole numbers; `opensTurn` for the first call of a turn. */
  call(session: string, useClass: UseClass, call: HeldCall, w: number, seconds: number, opensTurn: boolean): void {
    const row = this.rowOf(session, useClass, call);
    row.w += w;
    row.input += call.input;
    row.cacheWrite += call.cacheWrite;
    row.cacheRead += call.cacheRead;
    row.output += call.output;
    row.turns += opensTurn ? 1 : 0;
    row.calls += 1;
    row.seconds += seconds;
  }

  task(session: string, task: string | null, w: number, seconds: number): void {
    const key = JSON.stringify([session, task]);
    const row = this.tasks.get(key) ?? { session, task, w: 0, seconds: 0 };
    this.tasks.set(key, row);
    row.w += w;
    row.seconds += seconds;
  }

  rollup(): DayRollup {
    return { rows: [...this.rows.values()].sort(compareRows), tasks: [...this.tasks.values()].sort(compareTasks) };
  }

  private rowOf(session: string, useClass: UseClass, call: HeldCall): Mutable<UseRow> {
    const { model, effort } = call;
    const key = JSON.stringify([session, useClass, model, effort]);
    const row = this.rows.get(key) ?? { session, useClass, model, effort, w: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, calls: 0, seconds: 0 };
    this.rows.set(key, row);
    return row;
  }
}

/** One transcript's lines, in order. A turn is classed whole, so its calls wait for the next prompt or `end`. */
export class TranscriptFold {
  private readonly source: RollupSource;
  private readonly seen: Set<string>;
  private readonly dayOf: (day: string) => DayTally;
  private calls: HeldCall[] = [];
  private start: TurnStart | undefined;

  constructor(source: RollupSource, seen: Set<string>, dayOf: (day: string) => DayTally) {
    this.source = source;
    this.seen = seen;
    this.dayOf = dayOf;
  }

  line(line: TranscriptLine): void {
    if (line.kind === 'call') {
      this.reply(line);
    } else if (line.kind === 'prompt') {
      this.flush();
      this.start = { at: line.at, pushed: line.pushed === true };
    }
  }

  /** The transcript ended: its last turn closes with it. */
  end(): void {
    this.flush();
  }

  private reply(line: CallLine): void {
    const open = this.calls.at(-1);
    if (open !== undefined && line.key !== undefined && line.key === open.key) {
      open.w += Math.max(0, line.usage.output - open.output) * WEIGHTS.output;
      open.output = Math.max(open.output, line.usage.output);
      open.tools.push(...line.tools);
      return;
    }
    // A reply with no W is Claude Code's own text, not an API call; a resumed session's transcript repeats old replies.
    if (line.at === undefined || weightOf(line.usage) <= 0 || (line.key !== undefined && this.seen.has(line.key))) {
      return;
    }
    if (line.key !== undefined) {
      this.seen.add(line.key);
    }
    this.calls.push(heldCallOf(line, line.at));
  }

  private flush(): void {
    const { calls, source, start } = this;
    this.calls = [];
    const classes = classesOf(calls, source, start);
    const seconds = secondsOf(calls, source, start);
    const taskWork = new Map<string, { w: number; seconds: number }>();
    calls.forEach((call, index) => {
      const useClass = classes[index] ?? 'work';
      const day = formatUtcDay(new Date(call.at));
      const w = Math.round(call.w);
      const callSeconds = seconds[index] ?? 0;
      this.dayOf(day).call(source.session, useClass, call, w, callSeconds, index === 0 && !source.side);
      if (TASK_WORK_CLASSES.has(useClass)) {
        const held = taskWork.get(day) ?? { w: 0, seconds: 0 };
        taskWork.set(day, { w: held.w + w, seconds: held.seconds + callSeconds });
      }
    });
    this.chargeTasks(taskWork, turnTasksOf(calls));
  }

  /** A turn's task work splits equally over the tasks it named, on the days it fell on; with none named it stays a null row. */
  private chargeTasks(taskWork: ReadonlyMap<string, { readonly w: number; readonly seconds: number }>, tasks: readonly string[]): void {
    const named: readonly (string | null)[] = tasks.length === 0 ? [null] : tasks;
    for (const [day, { w, seconds }] of taskWork) {
      const wShares = evenShares(w, named.length);
      const secondShares = evenShares(seconds, named.length);
      named.forEach((task, index) => {
        this.dayOf(day).task(this.source.session, task, wShares[index] ?? 0, secondShares[index] ?? 0);
      });
    }
  }
}

/** One team's run over its transcripts. One set of reply keys covers them all, as a resumed session's file repeats another's. */
export class RollupFold {
  private readonly seen = new Set<string>();
  private readonly days = new Map<string, DayTally>();

  transcript(source: RollupSource): TranscriptFold {
    return new TranscriptFold(source, this.seen, (day) => this.dayTally(day));
  }

  /** The folded days, oldest first. */
  rollups(): ReadonlyMap<string, DayRollup> {
    const days = [...this.days.keys()].sort();
    return new Map(days.flatMap((day) => {
      const tally = this.days.get(day);
      return tally === undefined ? [] : [[day, tally.rollup()] as const];
    }));
  }

  private dayTally(day: string): DayTally {
    const tally = this.days.get(day) ?? new DayTally();
    this.days.set(day, tally);
    return tally;
  }
}
