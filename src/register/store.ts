import type { Files } from '../core/files.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { eventRecord, type RegisterEvent } from './events.ts';
import { RETAIN_DAYS } from './compaction.ts';
import { layoutPaths, readHistory, readWorkingSet, type LayoutPaths } from './layout.ts';
import { applyRotation, AUTO_ROTATE_CHARS, planRotation, type RotationPlan } from './rotate.ts';
import type { RegisterSnapshot } from './snapshot.ts';

/** The register's event log: an append-only tail, and once rotated, its archive and snapshot (layout.ts). */
export interface EventLog {
  /** The tail, `events.jsonl`, which every write appends to. */
  readonly path: string;
  /** The working set: every active task and every task finished recently, at the cost of the recent events. */
  read(): Promise<RegisterSnapshot>;
  /** Every task ever written, from the whole archive: the cost grows with the history. */
  readHistory(): Promise<RegisterSnapshot>;
  /** Appends one whole line; readers never need the lock. */
  /** The events of one write, in order, as one append. */
  append(events: readonly RegisterEvent[]): Promise<void>;
  /**
   * Under the writer's lock, after an append: rotates a log rotated before once its tail reaches
   * AUTO_ROTATE_CHARS (rotate.ts), and says how; null when it is not due. `written` is the read the write
   * decided on. A log never rotated is left alone: its first rotation is a person's, with `teamrig compact`.
   */
  rotateIfDue(written: RegisterSnapshot, now: Date): Promise<RotationPlan | null>;
}

export class JsonlEventLog implements EventLog {
  readonly path: string;
  private readonly files: Files;
  private readonly layout: LayoutPaths;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
    this.layout = layoutPaths(path);
  }

  read(): Promise<RegisterSnapshot> {
    return readWorkingSet(this.files, this.layout);
  }

  readHistory(): Promise<RegisterSnapshot> {
    return readHistory(this.files, this.layout);
  }

  async append(events: readonly RegisterEvent[]): Promise<void> {
    await this.files.append(this.path, events.map((event) => toJsonlLine(eventRecord(event))).join(''));
  }

  async rotateIfDue(written: RegisterSnapshot, now: Date): Promise<RotationPlan | null> {
    if (written.read.rotatedAfter === 0) {
      return null;
    }
    const tailText = (await this.files.read(this.path)) ?? '';
    if (tailText.length < AUTO_ROTATE_CHARS) {
      return null;
    }
    const plan = await planRotation(this.files, this.layout, { now, retainDays: RETAIN_DAYS, keep: new Set(), checkHistory: false }, tailText);
    await applyRotation(this.files, this.layout, plan);
    return plan;
  }
}
