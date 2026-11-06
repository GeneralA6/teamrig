import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Files } from '../core/files.ts';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  FIVE_HOUR_SUMMARY_FILE,
  FIVE_HOUR_SUMMARY_FORMAT,
  foldIntoFiveHourSummary,
  formatFiveHourSummary,
  parseFiveHourSummary,
  readFolderFiveHour,
  type FiveHourFold,
} from './five-hour-summary.ts';
import type { RateWindow, StatusSnapshot } from './snapshot.ts';

const DIR = '/live';
const SUMMARY = `${DIR}/${FIVE_HOUR_SUMMARY_FILE}`;
const RESETS_AT = Date.parse('2030-01-08T13:00:00.000Z');
const NEXT_RESETS_AT = Date.parse('2030-01-08T18:00:00.000Z');
const FIRST = '2030-01-08T08:10:00.000Z';
const SECOND = '2030-01-08T08:20:00.000Z';
const THIRD = '2030-01-08T08:30:00.000Z';

function snapshotOf(fiveHour: RateWindow | null, since: string | null, ts = THIRD): StatusSnapshot {
  return {
    ts,
    sessionId: '0000000a-0000-4000-8000-000000000001',
    cwd: '/work/app',
    agentName: null,
    model: 'Opus 5.5',
    rateLimits: { fiveHour, sevenDay: { usedPct: 10, resetsAt: Date.parse('2030-01-14T01:00:00.000Z') } },
    rateLimitsSince: since,
    rateLimitsAfter: null,
    costUsd: null,
    contextUsedPct: null,
    contextInputTokens: null,
  };
}

function reading(usedPct: number, since: string, resetsAt = RESETS_AT): StatusSnapshot {
  return snapshotOf({ usedPct, resetsAt }, since);
}

function foldOf(usedPct: number, at: string, firstPct: number, firstAt: string, resetsAt = RESETS_AT): FiveHourFold {
  return { resetsAt, usedPct, at: Date.parse(at), firstPct, firstAt: Date.parse(firstAt) };
}

/** The summary after folding each snapshot in turn into an empty folder. */
async function folded(...snapshots: readonly StatusSnapshot[]): Promise<FiveHourFold | undefined> {
  const files = new MemoryFiles({});
  for (const snapshot of snapshots) {
    await foldIntoFiveHourSummary(files, DIR, snapshot);
  }
  return readFolderFiveHour(files, DIR, Date.parse(FIRST));
}

/** A folder whose reads and writes are counted, to see what a status line run costs. */
class CountedFiles implements Pick<Files, 'read' | 'write'> {
  reads = 0;
  writes = 0;

  async read(): Promise<string | undefined> {
    this.reads += 1;
    return undefined;
  }

  async write(): Promise<void> {
    this.writes += 1;
  }
}

describe('the five-hour summary file', () => {
  it('stores a fold as the format its comment names, and reads it back', () => {
    const fold = foldOf(30, SECOND, 19, FIRST);
    const text = formatFiveHourSummary(fold);
    assert.equal(
      text,
      `{"v":${FIVE_HOUR_SUMMARY_FORMAT},"resets_at":${RESETS_AT / 1000},"used_percentage":30,"at":"${SECOND}","first_percentage":19,"first_at":"${FIRST}"}`,
    );
    assert.deepEqual(parseFiveHourSummary(text), fold);
  });

  it('reads as nothing when damaged, in another format, or short of a field', () => {
    const good = { v: FIVE_HOUR_SUMMARY_FORMAT, resets_at: 1, used_percentage: 2, at: FIRST, first_percentage: 1, first_at: FIRST };
    assert.ok(parseFiveHourSummary(JSON.stringify(good)) !== undefined);
    assert.equal(parseFiveHourSummary('not json'), undefined);
    assert.equal(parseFiveHourSummary(JSON.stringify({ ...good, v: FIVE_HOUR_SUMMARY_FORMAT + 1 })), undefined);
    assert.equal(parseFiveHourSummary(JSON.stringify({ ...good, resets_at: 'soon' })), undefined);
    assert.equal(parseFiveHourSummary(JSON.stringify({ ...good, used_percentage: null })), undefined);
    assert.equal(parseFiveHourSummary(JSON.stringify({ ...good, first_percentage: null })), undefined);
    assert.equal(parseFiveHourSummary(JSON.stringify({ ...good, at: 'yesterday' })), undefined);
    assert.equal(parseFiveHourSummary(JSON.stringify({ ...good, first_at: 7 })), undefined);
  });
});

describe('foldIntoFiveHourSummary', () => {
  it('opens and writes nothing for an account with no five-hour window, whose status line runs all day', async () => {
    const files = new CountedFiles();
    assert.equal(await foldIntoFiveHourSummary(files, DIR, snapshotOf(null, FIRST)), false);
    assert.deepEqual({ reads: files.reads, writes: files.writes }, { reads: 0, writes: 0 });
  });

  it('skips a reading it cannot date', async () => {
    const files = new MemoryFiles({});
    assert.equal(await foldIntoFiveHourSummary(files, DIR, reading(20, 'not a time')), false);
    assert.equal(await files.read(SUMMARY), undefined);
  });

  it('starts a window from its first reading, dated by when the session began to show it, else by the file', async () => {
    assert.deepEqual(await folded(reading(19, FIRST)), foldOf(19, FIRST, 19, FIRST));
    assert.deepEqual(await folded(snapshotOf({ usedPct: 19, resetsAt: RESETS_AT }, null, SECOND)), foldOf(19, SECOND, 19, SECOND));
  });

  it('moves to a higher reading and keeps the first, which the rate needs', async () => {
    assert.deepEqual(await folded(reading(19, FIRST), reading(30, SECOND)), foldOf(30, SECOND, 19, FIRST));
  });

  it('keeps the higher reading when a later one falls, as they did by a point between tabs', async () => {
    assert.deepEqual(await folded(reading(26, FIRST), reading(27, SECOND), reading(26, THIRD)), foldOf(27, SECOND, 26, FIRST));
  });

  it('takes the later of two equal readings, so a window gone quiet shows a falling rate', async () => {
    assert.deepEqual(await folded(reading(19, FIRST), reading(30, SECOND), reading(30, THIRD)), foldOf(30, THIRD, 19, FIRST));
  });

  it('takes an earlier first reading folded late', async () => {
    assert.deepEqual(await folded(reading(30, SECOND), reading(19, FIRST)), foldOf(30, SECOND, 19, FIRST));
  });

  it('replaces the window with a later one whole, whatever its percent, and ignores an older one after it', async () => {
    assert.deepEqual(await folded(reading(90, FIRST), reading(2, SECOND, NEXT_RESETS_AT)), foldOf(2, SECOND, 2, SECOND, NEXT_RESETS_AT));
    assert.deepEqual(await folded(reading(2, SECOND, NEXT_RESETS_AT), reading(90, THIRD)), foldOf(2, SECOND, 2, SECOND, NEXT_RESETS_AT));
  });

  it('writes only when the reading changes the summary', async () => {
    const files = new MemoryFiles({});
    assert.equal(await foldIntoFiveHourSummary(files, DIR, reading(19, FIRST)), true);
    assert.equal(await foldIntoFiveHourSummary(files, DIR, reading(19, FIRST)), false);
  });

  it('starts again from the reading when the summary is damaged', async () => {
    const files = new MemoryFiles({ [SUMMARY]: 'not json' });
    assert.equal(await foldIntoFiveHourSummary(files, DIR, reading(19, FIRST)), true);
    assert.deepEqual(await readFolderFiveHour(files, DIR, Date.parse(FIRST)), foldOf(19, FIRST, 19, FIRST));
  });

  it('refuses a summary a newer teamrig wrote, and leaves it', async () => {
    const newer = JSON.stringify({ v: FIVE_HOUR_SUMMARY_FORMAT + 1 });
    const files = new MemoryFiles({ [SUMMARY]: newer });
    await assert.rejects(foldIntoFiveHourSummary(files, DIR, reading(19, FIRST)), NewerDataError);
    assert.equal(await files.read(SUMMARY), newer);
  });
});

describe('readFolderFiveHour', () => {
  it('reads as no window when the folder has no summary, as for an account with none', async () => {
    assert.equal(await readFolderFiveHour(new MemoryFiles({}), DIR, Date.parse(FIRST)), undefined);
  });

  it('reads as no window when the summary is damaged', async () => {
    assert.equal(await readFolderFiveHour(new MemoryFiles({ [SUMMARY]: 'not json' }), DIR, Date.parse(FIRST)), undefined);
  });

  it('reads the window until it resets, then as none', async () => {
    const files = new MemoryFiles({ [SUMMARY]: formatFiveHourSummary(foldOf(30, SECOND, 19, FIRST)) });
    assert.deepEqual(await readFolderFiveHour(files, DIR, RESETS_AT - 1), foldOf(30, SECOND, 19, FIRST));
    assert.equal(await readFolderFiveHour(files, DIR, RESETS_AT), undefined);
  });
});
