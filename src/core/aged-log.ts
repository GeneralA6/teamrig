import { join } from 'node:path';
import type { Files } from './files.ts';
import { stringField } from './guards.ts';
import { parseObject } from './jsonl.ts';
import type { Clock, Mutex } from './lock.ts';
import type { LogFile } from './log-file.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an aged log keeps a record in place, and how much longer its oldest may stay there before a write
 * archives: the slack makes the rewrite run about once a day, not at every write.
 */
export interface AgePolicy {
  readonly keepDays: number;
  readonly slackDays: number;
}

/**
 * The hooks' aged logs (cli/hook-logs.ts). A dedup record (inbox-shown, bind-hints) older than a week belongs to a
 * Claude Code session that has almost always ended; one still running past it is shown an unread line or a hint once
 * more. The prompt answers feed a daily triage, which a week of them covers.
 */
export const HOOK_LOG_AGE: AgePolicy = { keepDays: 7, slackDays: 1 };

export interface AgeSplit {
  /** The leading lines to archive, as written: records dated before the cutoff and undated lines among them. */
  readonly moved: string;
  readonly movedLines: number;
  /** The rest as written, from the first record dated at or after the cutoff. */
  readonly kept: string;
  readonly keptLines: number;
}

/** A line's `at` in epoch milliseconds; undefined for a line that is not a record with a readable `at`. */
function dateOf(line: string): number | undefined {
  const record = parseObject(line.trim());
  const at = record === undefined ? undefined : stringField(record, 'at');
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
}

function countLines(lines: readonly string[]): number {
  return lines.filter((line) => line.trim() !== '').length;
}

/**
 * Splits a log at its first record dated at or after `cutoffMs`. Only that leading run moves, never an old record
 * written after a newer one: readers take a key's newest record by file order (inbox/shown.ts, hooks/hint-log.ts),
 * so every key that keeps a record keeps the same newest one.
 */
export function splitByAge(text: string, cutoffMs: number): AgeSplit {
  const lines = text.split(/(?<=\n)/);
  const first = lines.findIndex((line) => (dateOf(line) ?? Number.NEGATIVE_INFINITY) >= cutoffMs);
  const end = first === -1 ? lines.length : first;
  const moved = lines.slice(0, end);
  const kept = lines.slice(end);
  return { moved: moved.join(''), movedLines: countLines(moved), kept: kept.join(''), keptLines: countLines(kept) };
}

/** Where an aged log lives, and where its old records go. */
export interface AgedLogPaths {
  readonly live: string;
  /** The state archive: moved records are appended to `<archive>/<name>-YYYYMMDD.jsonl` (the run's UTC day), never deleted. */
  readonly archive: string;
  readonly name: string;
}

export interface AgedLogDeps {
  readonly files: Files;
  /** Taken by every append and every archive run, so no append lands between an archive's read and its rewrite. */
  readonly mutex: Mutex;
  readonly clock: Clock;
}

/** What an archive run moves, keeps and writes to. */
export interface AgeArchivePlan {
  readonly name: string;
  /** Records dated before this move. */
  readonly cutoff: Date;
  readonly split: AgeSplit;
  readonly archiveFile: string;
}

/**
 * A log whose writes keep it short: an append that finds its oldest record over `keepDays` + `slackDays` old moves
 * every record older than `keepDays` to the state archive, in the same lock (T336).
 */
export class AgedLogFile implements LogFile {
  private readonly deps: AgedLogDeps;
  private readonly paths: AgedLogPaths;
  private readonly policy: AgePolicy;

  constructor(deps: AgedLogDeps, paths: AgedLogPaths, policy: AgePolicy = HOOK_LOG_AGE) {
    this.deps = deps;
    this.paths = paths;
    this.policy = policy;
  }

  read(): Promise<string | undefined> {
    return this.deps.files.read(this.paths.live);
  }

  /** Appends under the log's lock, then archives when due. A failed archive leaves the append saved; the next write retries it. */
  async append(text: string): Promise<void> {
    await this.deps.mutex.run(async () => {
      await this.deps.files.append(this.paths.live, text);
      // The append is the caller's; the archive is upkeep that the next write runs again.
      await this.archiveIfDue().catch(() => undefined);
    });
  }

  /** What archiving now would move and keep; it reads only and takes no lock. */
  plan(): Promise<AgeArchivePlan> {
    return this.planBefore(this.cutoffMs(this.policy.keepDays));
  }

  /** Moves every record older than `keepDays` to the archive under the log's lock, due or not, and returns what it moved. */
  archive(): Promise<AgeArchivePlan> {
    return this.deps.mutex.run(() => this.archiveBefore(this.cutoffMs(this.policy.keepDays)));
  }

  private async archiveIfDue(): Promise<void> {
    const text = (await this.deps.files.read(this.paths.live)) ?? '';
    if (splitByAge(text, this.cutoffMs(this.policy.keepDays + this.policy.slackDays)).moved !== '') {
      await this.archiveBefore(this.cutoffMs(this.policy.keepDays));
    }
  }

  private async archiveBefore(cutoffMs: number): Promise<AgeArchivePlan> {
    const plan = await this.planBefore(cutoffMs);
    if (plan.split.moved !== '') {
      // The archive is written first: a rewrite that then fails leaves the records in both files, never in neither.
      await this.deps.files.append(plan.archiveFile, plan.split.moved);
      await this.deps.files.write(this.paths.live, plan.split.kept);
    }
    return plan;
  }

  private async planBefore(cutoffMs: number): Promise<AgeArchivePlan> {
    const text = (await this.deps.files.read(this.paths.live)) ?? '';
    const day = new Date(this.deps.clock.now()).toISOString().slice(0, 10).replaceAll('-', '');
    return {
      name: this.paths.name,
      cutoff: new Date(cutoffMs),
      split: splitByAge(text, cutoffMs),
      archiveFile: join(this.paths.archive, `${this.paths.name}-${day}.jsonl`),
    };
  }

  private cutoffMs(days: number): number {
    return this.deps.clock.now() - days * DAY_MS;
  }
}
