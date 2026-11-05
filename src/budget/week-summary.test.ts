import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Files } from '../core/files.ts';
import { NewerDataError } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { formatSnapshot, type StatusSnapshot, type WeekFold, type WeekUse } from './snapshot.ts';
import { foldIntoWeekSummary, formatWeekSummary, parseWeekSummary, readFolderWeek, WEEK_SUMMARY_FILE, WEEK_SUMMARY_FORMAT } from './week-summary.ts';

const ALPHA = '0000000a-0000-4000-8000-000000000001';
const BRAVO = '0000000b-0000-4000-8000-000000000002';
const NOW = Date.parse('2030-01-08T10:00:00.000Z');
/** Monday 2030-01-14 01:00 UTC, when this week resets. */
const RESETS_AT = Date.parse('2030-01-14T01:00:00.000Z');
const DIR = '/live';
const SUMMARY = `${DIR}/${WEEK_SUMMARY_FILE}`;

/** A session's snapshot whose week reading is `usedPct`, shown since `since` and taken after `after`. */
function reading(sessionId: string, usedPct: number, since: string, after: string | null = null): StatusSnapshot {
  return {
    ts: new Date(NOW).toISOString(),
    sessionId,
    cwd: '/work/app',
    agentName: null,
    model: 'Opus 5.5',
    rateLimits: { fiveHour: null, sevenDay: { usedPct, resetsAt: RESETS_AT } },
    rateLimitsSince: since,
    rateLimitsAfter: after,
    costUsd: null,
    contextUsedPct: null,
    contextInputTokens: null,
  };
}

function saved(...snapshots: readonly StatusSnapshot[]): MemoryFiles {
  return new MemoryFiles(Object.fromEntries(snapshots.map((snapshot) => [`${DIR}/${snapshot.sessionId}.json`, formatSnapshot(snapshot)])));
}

function fold(usedPct: number, at: string, followedBy?: string, after?: string): WeekFold {
  const best: WeekUse = { usedPct, resetsAt: RESETS_AT, at: Date.parse(at) };
  return { best: after === undefined ? best : { ...best, after: Date.parse(after) }, followedBy: followedBy === undefined ? undefined : Date.parse(followedBy) };
}

/** A folder whose lists, reads and writes are counted, to see what a reader opens. */
class CountedFiles implements Pick<Files, 'list' | 'read' | 'write'> {
  lists = 0;
  writes = 0;
  readonly reads: string[] = [];
  private readonly inner: Pick<Files, 'list' | 'read' | 'write'>;

  constructor(inner: Pick<Files, 'list' | 'read' | 'write'>) {
    this.inner = inner;
  }

  async list(dir: string): Promise<string[]> {
    this.lists += 1;
    return this.inner.list(dir);
  }

  async read(path: string): Promise<string | undefined> {
    this.reads.push(normalisePath(path));
    return this.inner.read(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.writes += 1;
    return this.inner.write(path, text);
  }
}

describe('formatWeekSummary and parseWeekSummary', () => {
  it('writes the reading with its reset in epoch seconds, and reads it back', () => {
    const kept = fold(46, '2030-01-08T09:59:00.000Z', '2030-01-08T09:58:00.000Z', '2030-01-08T09:57:00.000Z');
    const text = formatWeekSummary(kept);
    assert.equal(
      text,
      '{"v":2,"reading":{"used_percentage":46,"resets_at":1894582800,"at":"2030-01-08T09:59:00.000Z","after":"2030-01-08T09:57:00.000Z"},"followed_by":"2030-01-08T09:58:00.000Z"}',
    );
    assert.deepEqual(parseWeekSummary(text), kept);
    const none: WeekFold = { best: undefined, followedBy: undefined };
    assert.deepEqual(parseWeekSummary(formatWeekSummary(none)), none);
  });

  it('keeps a reading with no known earliest moment as one, so a reader never takes a time for it (T2019)', () => {
    const kept = fold(46, '2030-01-08T09:59:00.000Z');
    const text = formatWeekSummary(kept);
    assert.equal(text, '{"v":2,"reading":{"used_percentage":46,"resets_at":1894582800,"at":"2030-01-08T09:59:00.000Z","after":null},"followed_by":null}');
    assert.deepEqual(parseWeekSummary(text), kept);
  });

  it('writes the pinned fields of its format: a field added to the file raises WEEK_SUMMARY_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['followed_by', 'reading.at', 'reading.resets_at', 'reading.used_percentage', 'v'],
      2: ['followed_by', 'reading.after', 'reading.at', 'reading.resets_at', 'reading.used_percentage', 'v'],
    };
    const full = fold(46, '2030-01-08T09:59:00.000Z', '2030-01-08T09:58:00.000Z', '2030-01-08T09:57:00.000Z');
    assert.deepEqual(fieldPaths(JSON.parse(formatWeekSummary(full))), written[WEEK_SUMMARY_FORMAT]);
  });

  it('reads damaged text, or a format it cannot read, as none', () => {
    const at = '"at":"2030-01-08T09:59:00.000Z"';
    const damaged = [
      '{"reading":',
      '[]',
      '{}',
      '{"v":2,"reading":null}',
      `{"v":2,"reading":{"used_percentage":"46","resets_at":1,${at},"after":null},"followed_by":null}`,
      `{"v":2,"reading":{"used_percentage":46,"resets_at":1,${at}},"followed_by":null}`,
      `{"v":2,"reading":{"used_percentage":46,"resets_at":1,${at},"after":"soon"},"followed_by":null}`,
      '{"v":2,"reading":null,"followed_by":"soon"}',
    ];
    for (const text of [...damaged, '{"reading":null,"followed_by":null}', '{"v":1,"reading":null,"followed_by":null}', '{"v":3,"reading":null,"followed_by":null}']) {
      assert.equal(parseWeekSummary(text), undefined, text);
    }
  });
});

describe('readFolderWeek', () => {
  it('opens only the summary when the folder keeps a sound one', async () => {
    const memory = saved(reading(ALPHA, 40, '2030-01-08T09:00:00.000Z'));
    await memory.write(SUMMARY, formatWeekSummary(fold(50, '2030-01-08T09:30:00.000Z')));
    const files = new CountedFiles(memory);
    assert.deepEqual(await readFolderWeek(files, DIR, NOW), fold(50, '2030-01-08T09:30:00.000Z'));
    assert.deepEqual(files.reads, [SUMMARY]);
    assert.equal(files.lists, 0);
  });

  it('reads every snapshot when the summary is missing or damaged', async () => {
    const files = saved(reading(ALPHA, 40, '2030-01-08T09:00:00.000Z'), reading(BRAVO, 45, '2030-01-08T09:30:00.000Z'));
    assert.deepEqual(await readFolderWeek(files, DIR, NOW), fold(45, '2030-01-08T09:30:00.000Z'));
    await files.write(SUMMARY, 'damaged');
    assert.deepEqual(await readFolderWeek(files, DIR, NOW), fold(45, '2030-01-08T09:30:00.000Z'));
  });
});

describe('foldIntoWeekSummary', () => {
  /** Alpha's new reading, saved as the status line saves it before it folds: its old 40 changed at 09:58. */
  const alphaNew = reading(ALPHA, 46, '2030-01-08T09:59:00.000Z', '2030-01-08T09:58:00.000Z');

  it('seeds a missing summary from every snapshot, then folds each later one opening only the summary', async () => {
    const memory = saved(alphaNew, reading(BRAVO, 45, '2030-01-08T09:30:00.000Z'));
    assert.equal(await foldIntoWeekSummary(memory, DIR, alphaNew, NOW), true);
    const seeded = fold(46, '2030-01-08T09:59:00.000Z', '2030-01-08T09:58:00.000Z', '2030-01-08T09:58:00.000Z');
    assert.deepEqual(parseWeekSummary(memory.get(SUMMARY) ?? ''), seeded, "bravo's 45 was taken before alpha's reading changed");

    const bravoNew = reading(BRAVO, 47, '2030-01-08T10:00:00.000Z', '2030-01-08T09:59:30.000Z');
    await memory.write(`${DIR}/${BRAVO}.json`, formatSnapshot(bravoNew));
    const files = new CountedFiles(memory);
    assert.equal(await foldIntoWeekSummary(files, DIR, bravoNew, NOW), true);
    assert.deepEqual(files.reads, [SUMMARY]);
    assert.equal(files.lists, 0);
    assert.deepEqual(parseWeekSummary(memory.get(SUMMARY) ?? ''), fold(47, '2030-01-08T10:00:00.000Z', '2030-01-08T09:59:30.000Z', '2030-01-08T09:59:30.000Z'));
  });

  it('writes nothing when the snapshot changes nothing, as on a redraw', async () => {
    const memory = saved(alphaNew);
    await foldIntoWeekSummary(memory, DIR, alphaNew, NOW);
    const files = new CountedFiles(memory);
    assert.equal(await foldIntoWeekSummary(files, DIR, alphaNew, NOW), false);
    assert.equal(files.writes, 0);
  });

  it('rebuilds a damaged summary from every snapshot', async () => {
    const memory = saved(alphaNew, reading(BRAVO, 48, '2030-01-08T09:59:10.000Z'));
    await memory.write(SUMMARY, '{"reading":');
    assert.equal(await foldIntoWeekSummary(memory, DIR, alphaNew, NOW), true);
    assert.deepEqual(parseWeekSummary(memory.get(SUMMARY) ?? ''), fold(48, '2030-01-08T09:59:10.000Z', '2030-01-08T09:58:00.000Z'));
  });

  it('rebuilds a summary of the format before, which holds no earliest moment, from every snapshot (T2019)', async () => {
    const memory = saved(alphaNew);
    await memory.write(SUMMARY, '{"v":1,"reading":{"used_percentage":46,"resets_at":1894582800,"at":"2030-01-08T09:59:00.000Z"},"followed_by":"2030-01-08T09:58:00.000Z"}');
    assert.equal(await foldIntoWeekSummary(memory, DIR, alphaNew, NOW), true);
    assert.deepEqual(parseWeekSummary(memory.get(SUMMARY) ?? ''), fold(46, '2030-01-08T09:59:00.000Z', '2030-01-08T09:58:00.000Z', '2030-01-08T09:58:00.000Z'));
  });

  it('refuses a summary a newer teamrig wrote, leaving it as it was', async () => {
    const memory = saved(alphaNew);
    const newer = '{"v":3,"reading":null,"followed_by":null}';
    await memory.write(SUMMARY, newer);
    await assert.rejects(foldIntoWeekSummary(memory, DIR, alphaNew, NOW), (error: unknown) => error instanceof NewerDataError && error.found === 3 && error.known === WEEK_SUMMARY_FORMAT);
    assert.equal(memory.get(SUMMARY), newer);
  });
});
