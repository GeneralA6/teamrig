import type { Files } from '../core/files.ts';
import { assertWritable, parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import type { Mutex } from '../core/lock.ts';
import {
  foldGoalLines,
  GOAL_RECORD_VERSION,
  goalAddRefusal,
  goalRankRefusal,
  goalRecordJson,
  goalSetRefusal,
  readGoals,
  type GoalAdd,
  type GoalAddInput,
  type GoalRank,
  type GoalRankInput,
  type GoalRecord,
  type GoalSet,
  type GoalSetInput,
  type GoalsRead,
  type KeyResultCap,
} from './goals.ts';

/** Who writes a goal record, and when (an ISO time). */
export interface GoalWriter {
  readonly by: string;
  readonly at: string;
}

/** What a write did: the record it appended, or why it appended nothing. */
export type GoalWrite = { readonly kind: 'written'; readonly record: GoalRecord } | { readonly kind: 'refused'; readonly reason: string };

/**
 * A team's goal records file (T1730): reads fold it, writes append one record under the lock after re-reading it, so
 * two leads' writes never both pass a check that only one of them can (two adds of one tag, or two key results past
 * the cap). A file holding records
 * of a newer teamrig is refused for writes (NewerDataError), never mixed with this version's.
 */
export class GoalStore {
  private readonly files: Pick<Files, 'read' | 'append'>;
  private readonly path: string;
  private readonly mutex: Mutex;

  constructor(files: Pick<Files, 'read' | 'append'>, path: string, mutex: Mutex) {
    this.files = files;
    this.path = path;
    this.mutex = mutex;
  }

  /** The goals as recorded; none when the file does not exist yet. */
  async read(): Promise<GoalsRead> {
    return readGoals(await this.files.read(this.path));
  }

  /** Adds a goal, unless goalAddRefusal refuses it over the records as they stand under the lock, a key result past `cap` among them. */
  async add(input: GoalAddInput, writer: GoalWriter, cap: KeyResultCap): Promise<GoalWrite> {
    return this.mutex.run(async () => {
      const reason = goalAddRefusal(input, (await this.writable()).goals, cap);
      if (reason !== undefined) {
        return { kind: 'refused', reason };
      }
      const record: GoalAdd = { type: 'goal-add', ...writer, tag: input.tag, title: input.title, start: input.start, target: input.target, parent: input.parent };
      return this.append(record);
    });
  }

  /** Moves a goal's target or renames it, with the note saying why, unless goalSetRefusal refuses it. */
  async set(input: GoalSetInput, writer: GoalWriter): Promise<GoalWrite> {
    return this.mutex.run(async () => {
      const reason = goalSetRefusal(input, (await this.writable()).goals);
      if (reason !== undefined) {
        return { kind: 'refused', reason };
      }
      const record: GoalSet = { type: 'goal-set', ...writer, tag: input.tag, target: input.target, title: input.title, slice: input.slice, note: input.note };
      return this.append(record);
    });
  }

  /** Ranks a goal, or takes it off the ranking (null), unless goalRankRefusal refuses it (T2083). */
  async rank(input: GoalRankInput, writer: GoalWriter): Promise<GoalWrite> {
    return this.mutex.run(async () => {
      const reason = goalRankRefusal(input, (await this.writable()).goals);
      if (reason !== undefined) {
        return { kind: 'refused', reason };
      }
      const record: GoalRank = { type: 'goal-rank', ...writer, tag: input.tag, rank: input.rank };
      return this.append(record);
    });
  }

  /** The records as they stand, refused when a newer teamrig wrote some. */
  private async writable(): Promise<GoalsRead> {
    const parsed = parseJsonl((await this.files.read(this.path)) ?? '');
    assertWritable(this.path, parsed, GOAL_RECORD_VERSION);
    return foldGoalLines(parsed);
  }

  private async append(record: GoalRecord): Promise<GoalWrite> {
    await this.files.append(this.path, toJsonlLine(goalRecordJson(record)));
    return { kind: 'written', record };
  }
}
