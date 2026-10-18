import type { PromptLine, ToolResult, ToolUse, TranscriptLine } from '../budget/line.ts';
import { formatUtcDay } from '../core/time.ts';
import type { SkillSignature } from './signature.ts';

/**
 * The skills scorecard's fold: per UTC day and skill, how often the skill was loaded, what a run of it cost (tool
 * calls, failed and refused results) and how often its procedure ran by hand without it (a missed use). A run starts
 * at a load (a `Skill` call or a typed `/name`) or, without one, at the first call that matches the skill's
 * signature, and ends at the next prompt that starts new work. Each transcript file is one thread, a subagent's too.
 */

/** A signature hit this many tool calls or fewer after a load of the skill is the skill at work, not a missed use. */
export const LOAD_WINDOW_CALLS = 30;

/** Error results that are a guard's or a permission's refusal rather than a failing step. */
export const REFUSAL_PREFIXES = [
  'This session is isolated in the worktree',
  'Permission for this action was denied by the Claude Code auto mode',
  "The user doesn't want to proceed with this tool use",
] as const;

/** Prompts that start new work and so end the thread's open runs; a notification or a resumed compaction continues them. */
const RUN_ENDING_TRIGGERS: ReadonlySet<PromptLine['trigger']> = new Set(['owner', 'peer', 'scheduled', 'subagent', 'other']);

/** A Write or Edit of a file under a `.claude/skills/<name>/` folder edits that skill. */
const SKILL_EDIT_PATH = /[\\/]\.claude[\\/]skills[\\/]([^\\/]+)[\\/]/;
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);
const TOOL_USE_ERROR = /^\s*<tool_use_error>/;

export interface RunTally {
  readonly runs: number;
  readonly calls: number;
  readonly failed: number;
  readonly refused: number;
}

export interface SkillDay {
  readonly loads: number;
  /** Runs after a load of the skill. */
  readonly skill: RunTally;
  /** Runs of the skill's signature with no load before them: missed uses, or the baseline before the skill existed. */
  readonly manual: RunTally;
  /** Writes and edits of the skill's own files. */
  readonly edits: number;
}

export type RunMode = 'skill' | 'manual';

/** A run still going when the read stopped; it is charged to the day it started on once it ends. */
export interface OpenRun {
  readonly skill: string;
  readonly mode: RunMode;
  readonly day: string;
  readonly calls: number;
  readonly failed: number;
  readonly refused: number;
}

/** Where the read of one transcript file stands, and its thread's state at that point. */
export interface ThreadCursor {
  /** The offset of the first byte not yet counted, always the start of a line. */
  readonly offset: number;
  /** The file's size at the last read. */
  readonly size: number;
  /** Epoch ms of the last line counted; every line before `offset` is no newer. */
  readonly lastAt: number;
  /** Tool calls in the thread so far. */
  readonly calls: number;
  /** Skill name to the thread's call count at its last load. */
  readonly lastLoad: Readonly<Record<string, number>>;
  readonly open: readonly OpenRun[];
}

/** UTC day (`YYYY-MM-DD`) to skill name to its counts. */
export type ScorecardDays = Readonly<Record<string, Readonly<Record<string, SkillDay>>>>;

export interface ScorecardState {
  /** The first UTC day counted in full: the first read started there, so earlier days are missing. */
  readonly since: string;
  readonly days: ScorecardDays;
  /** Transcript path to its cursor. */
  readonly cursors: Readonly<Record<string, ThreadCursor>>;
}

/** The skills the fold knows: every installed skill's name, and the signatures of those that have one. */
export interface ScorecardSkills {
  readonly names: ReadonlySet<string>;
  readonly signatures: readonly SkillSignature[];
}

export const EMPTY_TALLY: RunTally = { runs: 0, calls: 0, failed: 0, refused: 0 };
export const EMPTY_SKILL_DAY: SkillDay = { loads: 0, skill: EMPTY_TALLY, manual: EMPTY_TALLY, edits: 0 };

/** A cursor for a file first read at `offset`, the first line at or after `since`. */
export function newThread(offset: number, size: number, since: number): ThreadCursor {
  return { offset, size, lastAt: since, calls: 0, lastLoad: {}, open: [] };
}

/** True for an error result that a guard or a permission refused, not a step that failed. */
export function isRefusal(text: string): boolean {
  const message = text.replace(TOOL_USE_ERROR, '').trimStart();
  return REFUSAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function withRun(tally: RunTally, run: OpenRun): RunTally {
  return { runs: tally.runs + 1, calls: tally.calls + run.calls, failed: tally.failed + run.failed, refused: tally.refused + run.refused };
}

/** The per-day, per-skill counts a scan adds to. */
export class ScorecardTally {
  private readonly byDay: Record<string, Record<string, SkillDay>>;

  constructor(days: ScorecardDays) {
    this.byDay = Object.fromEntries(Object.entries(days).map(([day, skills]) => [day, { ...skills }]));
  }

  load(day: string, skill: string): void {
    this.update(day, skill, (current) => ({ ...current, loads: current.loads + 1 }));
  }

  edit(day: string, skill: string): void {
    this.update(day, skill, (current) => ({ ...current, edits: current.edits + 1 }));
  }

  /** Charges an ended run to the day it started on. */
  close(run: OpenRun): void {
    this.update(run.day, run.skill, (current) =>
      run.mode === 'skill' ? { ...current, skill: withRun(current.skill, run) } : { ...current, manual: withRun(current.manual, run) },
    );
  }

  days(): ScorecardDays {
    return this.byDay;
  }

  private update(day: string, skill: string, change: (current: SkillDay) => SkillDay): void {
    const skills = (this.byDay[day] ??= {});
    skills[skill] = change(skills[skill] ?? EMPTY_SKILL_DAY);
  }
}

/** Folds one transcript file's lines, in order, into the tally, continuing from its cursor. */
export class ThreadFold {
  private readonly tally: ScorecardTally;
  private readonly skills: ScorecardSkills;
  private readonly lastLoad: Record<string, number>;
  private lastAt: number;
  private calls: number;
  private open: OpenRun[];

  constructor(cursor: ThreadCursor, tally: ScorecardTally, skills: ScorecardSkills) {
    this.tally = tally;
    this.skills = skills;
    this.lastLoad = { ...cursor.lastLoad };
    this.lastAt = cursor.lastAt;
    this.calls = cursor.calls;
    this.open = [...cursor.open];
  }

  /** Counts one line; a line with no readable time counts on the day of the line before it. */
  line(line: TranscriptLine): void {
    this.lastAt = line.at ?? this.lastAt;
    const day = formatUtcDay(new Date(this.lastAt));
    if (line.kind === 'prompt') {
      this.prompt(line, day);
    } else if (line.kind === 'call') {
      for (const tool of line.tools) {
        this.tool(tool, day);
      }
    } else if (line.kind === 'results') {
      this.results(line.results);
    }
  }

  /** Charges every open run, for a thread that went idle. */
  closeAll(): void {
    for (const run of this.open) {
      this.tally.close(run);
    }
    this.open = [];
  }

  cursor(offset: number, size: number): ThreadCursor {
    return { offset, size, lastAt: this.lastAt, calls: this.calls, lastLoad: { ...this.lastLoad }, open: [...this.open] };
  }

  private prompt(line: PromptLine, day: string): void {
    if (RUN_ENDING_TRIGGERS.has(line.trigger)) {
      this.closeAll();
    }
    for (const command of line.commands) {
      if (this.skills.names.has(command)) {
        this.load(command, day);
      }
    }
  }

  private tool(tool: ToolUse, day: string): void {
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
    for (const signature of this.skills.signatures) {
      if (signature.patterns.some((pattern) => pattern.test(haystack)) && !this.loadedRecently(signature.name) && !this.isOpen(signature.name)) {
        this.open.push({ skill: signature.name, mode: 'manual', day, calls: 1, failed: 0, refused: 0 });
      }
    }
  }

  private results(results: readonly ToolResult[]): void {
    for (const result of results) {
      if (!result.isError) {
        continue;
      }
      const refused = isRefusal(result.text);
      this.open = this.open.map((run) => (refused ? { ...run, refused: run.refused + 1 } : { ...run, failed: run.failed + 1 }));
    }
  }

  /** A load mid-procedure makes the rest the skill's run, so the hand run so far is dropped; a reload continues the run. */
  private load(skill: string, day: string): void {
    this.tally.load(day, skill);
    this.lastLoad[skill] = this.calls;
    if (this.open.some((run) => run.skill === skill && run.mode === 'skill')) {
      return;
    }
    this.open = [...this.open.filter((run) => run.skill !== skill), { skill, mode: 'skill', day, calls: 0, failed: 0, refused: 0 }];
  }

  private loadedRecently(skill: string): boolean {
    const at = this.lastLoad[skill];
    return at !== undefined && this.calls - at <= LOAD_WINDOW_CALLS;
  }

  private isOpen(skill: string): boolean {
    return this.open.some((run) => run.skill === skill);
  }
}
