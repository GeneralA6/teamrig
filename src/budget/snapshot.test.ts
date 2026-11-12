import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import {
  datedSnapshot,
  defaultSnapshotDir,
  effortOfStatus,
  formatSnapshot,
  mergeWeekFolds,
  parseSnapshot,
  pruneSnapshots,
  readSnapshots,
  SNAPSHOT_DAYS_KEPT,
  SNAPSHOT_PRUNE_EVERY_MS,
  SNAPSHOT_PRUNED_FILE,
  SNAPSHOT_TEMPORARY_KEPT_MS,
  snapshotDirOf,
  snapshotOfStatus,
  statusLineText,
  weekFoldOf,
  weekUseAt,
  type StatusSnapshot,
  type WeekFold,
  type WeekUse,
} from './snapshot.ts';

const SID = '0b6f9c2e-5d1a-4c3e-9f7a-2e8d4b1c6a90';
const OTHER = '7d2e41a8-93c5-4f60-b1d7-5a9e0c3f8b24';
const NOW = Date.parse('2026-10-15T12:00:50.598Z');
/** Wednesday 2026-10-21 01:00 UTC, in epoch seconds as Claude Code sends it. */
const WEEK_RESET_S = 1792544400;

/** Claude Code's status line input, as much of it as a snapshot keeps and some it does not. */
const STATUS_INPUT = {
  hook_event_name: 'Status',
  session_id: SID,
  transcript_path: `/home/you/.claude/projects/p/${SID}.jsonl`,
  cwd: '/work/app/sub',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: '/work/app', project_dir: '/work/app' },
  version: '2.1.0',
  cost: { total_cost_usd: 857.79, total_duration_ms: 1000 },
  context_window: { used_percentage: 15, total_input_tokens: 153654 },
  rate_limits: { five_hour: { used_percentage: 6, resets_at: 1792081200 }, seven_day: { used_percentage: 57, resets_at: WEEK_RESET_S } },
  agent: { name: 'reviewer' },
};
const STATUS = JSON.stringify(STATUS_INPUT);

/** The pinned file format: a status line of any make that writes this is read by `teamrig budget`. */
const STORED =
  '{"ts":"2026-10-15T12:00:50.598Z","session_id":"0b6f9c2e-5d1a-4c3e-9f7a-2e8d4b1c6a90","cwd":"/work/app",' +
  '"agent_name":"reviewer","model":"Opus 5.5","rate_limits":{"five_hour":{"used_percentage":6,"resets_at":1792081200},' +
  '"seven_day":{"used_percentage":57,"resets_at":1792544400}},"rate_limits_since":"2026-10-15T12:00:50.598Z","rate_limits_after":null,' +
  '"cost_usd":857.79,"context_used_pct":15,"context_input_tokens":153654}';

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    ts: '2026-10-15T12:00:00.000Z',
    sessionId: SID,
    cwd: '/work/app',
    agentName: null,
    model: 'Opus 5.5',
    rateLimits: { fiveHour: null, sevenDay: { usedPct: 57, resetsAt: WEEK_RESET_S * 1000 } },
    rateLimitsSince: null,
    rateLimitsAfter: null,
    costUsd: null,
    contextUsedPct: null,
    contextInputTokens: null,
    ...overrides,
  };
}

/** The reading that counts among the snapshots at `now`. */
function weekUseOf(snapshots: readonly StatusSnapshot[], now: number): WeekUse | undefined {
  return weekFoldOf(snapshots, now).best;
}

/** A snapshot written at `ts` whose week reading is `usedPct`, shown since `since` and taken after `after`. */
function reading(ts: string, usedPct: number, since: string | null = null, after: string | null = null): StatusSnapshot {
  return snapshot({ ts, rateLimits: { fiveHour: null, sevenDay: { usedPct, resetsAt: WEEK_RESET_S * 1000 } }, rateLimitsSince: since, rateLimitsAfter: after });
}

describe('snapshotOfStatus and formatSnapshot', () => {
  it('writes the pinned format from Claude Code status input', () => {
    const taken = snapshotOfStatus(`${STATUS}\n`, NOW);
    assert.ok(taken !== undefined);
    assert.equal(formatSnapshot(taken), STORED);
  });

  it('takes the session id from the transcript name, and the folder from cwd, when they are missing', () => {
    const taken = snapshotOfStatus(JSON.stringify({ transcript_path: `/p/${SID}.jsonl`, cwd: '/work/app/sub' }), NOW);
    assert.equal(taken?.sessionId, SID);
    assert.equal(taken?.cwd, '/work/app/sub');
    assert.equal(taken?.model, null);
    assert.equal(taken?.rateLimits, null);
    assert.equal(snapshotOfStatus(JSON.stringify({ session_id: SID }), NOW)?.cwd, '');
  });

  it('keeps a window that is there and drops a damaged one', () => {
    const input = JSON.stringify({ session_id: SID, rate_limits: { seven_day: { used_percentage: 12, resets_at: WEEK_RESET_S }, five_hour: { used_percentage: 'x' } } });
    assert.deepEqual(snapshotOfStatus(input, NOW)?.rateLimits, { fiveHour: null, sevenDay: { usedPct: 12, resetsAt: WEEK_RESET_S * 1000 } });
    const none = JSON.stringify({ session_id: SID, rate_limits: { five_hour: null } });
    assert.equal(snapshotOfStatus(none, NOW)?.rateLimits, null);
  });

  it('refuses input that is not an object or names no valid session', () => {
    assert.equal(snapshotOfStatus('', NOW), undefined);
    assert.equal(snapshotOfStatus('[1]', NOW), undefined);
    assert.equal(snapshotOfStatus(JSON.stringify({ session_id: '../../etc/passwd' }), NOW), undefined);
    assert.equal(snapshotOfStatus(JSON.stringify({ cwd: '/work' }), NOW), undefined);
  });
});

describe('parseSnapshot', () => {
  it('reads the pinned format back', () => {
    const read = parseSnapshot(STORED);
    assert.ok(read !== undefined);
    assert.equal(formatSnapshot(read), STORED);
  });

  it('reads another status line that copies the whole rate_limits object, with keys it does not know', () => {
    const text = JSON.stringify({
      ts: '2026-10-15T11:47:43.179Z',
      session_id: OTHER,
      cwd: 'C:\\work',
      rate_limits: { seven_day: { used_percentage: 47, resets_at: WEEK_RESET_S, extra: true } },
      note: 'kept by its writer',
    });
    assert.deepEqual(parseSnapshot(text), {
      ts: '2026-10-15T11:47:43.179Z',
      sessionId: OTHER,
      cwd: 'C:\\work',
      agentName: null,
      model: null,
      rateLimits: { fiveHour: null, sevenDay: { usedPct: 47, resetsAt: WEEK_RESET_S * 1000 } },
      rateLimitsSince: null,
      rateLimitsAfter: null,
      costUsd: null,
      contextUsedPct: null,
      contextInputTokens: null,
    });
  });

  it("reads the reading's dates only when they come before the file, and the time after it before the time since", () => {
    const dates = (since: unknown, after: unknown, rateLimits: unknown = { seven_day: { used_percentage: 1, resets_at: WEEK_RESET_S } }) => {
      const read = parseSnapshot(JSON.stringify({ ts: '2026-10-15T12:00:00.000Z', session_id: SID, rate_limits: rateLimits, rate_limits_since: since, rate_limits_after: after }));
      return [read?.rateLimitsSince, read?.rateLimitsAfter];
    };
    assert.deepEqual(dates('2026-10-15T11:00:00.000Z', '2026-10-15T10:00:00.000Z'), ['2026-10-15T11:00:00.000Z', '2026-10-15T10:00:00.000Z']);
    assert.deepEqual(dates('2026-10-15T12:00:00.000Z', '2026-10-15T12:00:00.000Z'), ['2026-10-15T12:00:00.000Z', null]);
    assert.deepEqual(dates('2026-10-15T13:00:00.000Z', '2026-10-15T11:30:00.000Z'), [null, '2026-10-15T11:30:00.000Z']);
    assert.deepEqual(dates('soon', 5), [null, null]);
    assert.deepEqual(dates('2026-10-15T11:00:00.000Z', '2026-10-15T10:00:00.000Z', null), [null, null]);
  });

  it('refuses a damaged file or one without a time or a valid session id', () => {
    assert.equal(parseSnapshot('{"ts":'), undefined);
    assert.equal(parseSnapshot(JSON.stringify({ session_id: SID })), undefined);
    assert.equal(parseSnapshot(JSON.stringify({ ts: 'yesterday', session_id: SID })), undefined);
    assert.equal(parseSnapshot(JSON.stringify({ ts: '2026-10-15T00:00:00Z', session_id: 'x' })), undefined);
  });
});

describe('datedSnapshot', () => {
  const first = reading('2026-10-15T10:00:00.000Z', 57, '2026-10-15T10:00:00.000Z', '2026-10-15T09:00:00.000Z');
  const redrawn = reading('2026-10-15T11:00:00.000Z', 57, '2026-10-15T11:00:00.000Z');
  const changed = reading('2026-10-15T11:00:00.000Z', 0.4, '2026-10-15T11:00:00.000Z');

  it("keeps a session's first snapshot, one without rate limits and one whose previous file names another session", () => {
    assert.equal(datedSnapshot(redrawn, undefined), redrawn);
    const none = snapshot({ rateLimits: null });
    assert.equal(datedSnapshot(none, first), none);
    assert.equal(datedSnapshot(changed, { ...first, sessionId: OTHER }), changed);
  });

  it('carries the dates of rate limits the previous snapshot already showed, as Claude Code redraws them until the next reply', () => {
    assert.deepEqual(datedSnapshot(redrawn, first), { ...redrawn, rateLimitsSince: '2026-10-15T10:00:00.000Z', rateLimitsAfter: '2026-10-15T09:00:00.000Z' });
    const undated = reading('2026-10-15T10:30:00.000Z', 57);
    assert.deepEqual(datedSnapshot(redrawn, undated), { ...redrawn, rateLimitsSince: '2026-10-15T10:30:00.000Z', rateLimitsAfter: null });
  });

  it('dates other rate limits after the previous snapshot, a change in the five-hour window alone too', () => {
    assert.deepEqual(datedSnapshot(changed, first), { ...changed, rateLimitsAfter: '2026-10-15T10:00:00.000Z' });
    assert.deepEqual(datedSnapshot(changed, snapshot({ ts: '2026-10-15T10:00:00.000Z', rateLimits: null })), { ...changed, rateLimitsAfter: '2026-10-15T10:00:00.000Z' });
    const week = { usedPct: 57, resetsAt: WEEK_RESET_S * 1000 };
    const fiveHour = snapshot({ ts: '2026-10-15T11:00:00.000Z', rateLimits: { fiveHour: { usedPct: 7, resetsAt: NOW }, sevenDay: week }, rateLimitsSince: '2026-10-15T11:00:00.000Z' });
    const shown = snapshot({ ts: '2026-10-15T10:00:00.000Z', rateLimits: { fiveHour: { usedPct: 6, resetsAt: NOW }, sevenDay: week } });
    assert.equal(datedSnapshot(fiveHour, shown).rateLimitsAfter, '2026-10-15T10:00:00.000Z');
    assert.equal(datedSnapshot(changed, { ...first, ts: changed.ts }).rateLimitsAfter, null, 'a previous file not written before this one dates nothing');
  });
});

describe('weekFoldOf: the reading that counts', () => {
  const resetsAt = WEEK_RESET_S * 1000;

  it("drops readings taken before another one is known to follow, so the owner's mid-week reset shows at once", () => {
    const use = weekUseOf(
      [
        reading('2026-10-15T12:00:40.000Z', 98, '2026-10-15T09:00:00.000Z'),
        reading('2026-10-15T11:59:00.000Z', 98),
        reading('2026-10-15T12:00:30.000Z', 0.4, '2026-10-15T12:00:30.000Z', '2026-10-15T12:00:00.000Z'),
      ],
      NOW,
    );
    assert.deepEqual(use, { usedPct: 0.4, resetsAt, at: Date.parse('2026-10-15T12:00:30.000Z'), after: Date.parse('2026-10-15T12:00:00.000Z') });
  });

  it('takes the highest of the readings no other is known to follow', () => {
    const use = weekUseOf(
      [
        reading('2026-10-15T12:00:30.000Z', 0.4, '2026-10-15T12:00:30.000Z', '2026-10-15T12:00:00.000Z'),
        reading('2026-10-15T12:00:40.000Z', 0.6, '2026-10-15T12:00:10.000Z', '2026-10-15T11:00:00.000Z'),
        reading('2026-10-15T12:00:20.000Z', 0.5),
      ],
      NOW,
    );
    assert.deepEqual(use, { usedPct: 0.6, resetsAt, at: Date.parse('2026-10-15T12:00:10.000Z'), after: Date.parse('2026-10-15T11:00:00.000Z') });
  });

  it('takes the highest reading of the current week when none is dated, as a week only grows', () => {
    const use = weekUseOf(
      [
        snapshot({ ts: '2026-10-15T12:00:00.000Z', rateLimits: { fiveHour: null, sevenDay: { usedPct: 47, resetsAt } } }),
        snapshot({ ts: '2026-10-15T11:00:00.000Z', rateLimits: { fiveHour: null, sevenDay: { usedPct: 57, resetsAt } } }),
        snapshot({ ts: '2026-10-15T10:00:00.000Z', rateLimits: { fiveHour: null, sevenDay: { usedPct: 50, resetsAt } } }),
      ],
      NOW,
    );
    assert.deepEqual(use, { usedPct: 57, resetsAt, at: Date.parse('2026-10-15T11:00:00.000Z') });
  });

  it('dates a reading by when its session began to show it, so a redraw that rewrote its file after now keeps it', () => {
    const redrawn = reading('2026-10-15T12:00:51.000Z', 58, '2026-10-15T11:35:00.000Z', '2026-10-15T11:34:55.000Z');
    const older = reading('2026-10-15T12:00:00.000Z', 57, '2026-10-15T11:00:00.000Z');
    const expected = { usedPct: 58, resetsAt, at: Date.parse('2026-10-15T11:35:00.000Z'), after: Date.parse('2026-10-15T11:34:55.000Z') };
    assert.deepEqual(weekUseOf([redrawn, older], NOW), expected);
    const takenAfter = reading('2026-10-15T12:00:52.000Z', 59, '2026-10-15T12:00:51.000Z', '2026-10-15T12:00:45.000Z');
    assert.deepEqual(weekUseOf([redrawn, older, takenAfter], NOW), expected, 'a reading its session began to show after now is not counted');
  });

  it('prefers a later week, and skips readings from the future, past weeks and sessions without one', () => {
    const lastWeek = resetsAt - 7 * 86_400_000;
    const use = weekUseOf(
      [
        snapshot({ rateLimits: { fiveHour: null, sevenDay: { usedPct: 99, resetsAt: lastWeek } } }),
        snapshot({ ts: '2026-10-16T00:00:00.000Z' }),
        snapshot({ rateLimits: null }),
        snapshot({ rateLimits: { fiveHour: { usedPct: 3, resetsAt: NOW + 1 }, sevenDay: null } }),
        snapshot({ rateLimits: { fiveHour: null, sevenDay: { usedPct: 10, resetsAt: resetsAt - 3_600_000 } } }),
        snapshot({ rateLimits: { fiveHour: null, sevenDay: { usedPct: 4, resetsAt } } }),
      ],
      NOW,
    );
    assert.equal(use?.usedPct, 4);
    assert.equal(weekUseOf([], NOW), undefined);
  });
});

describe('weekFoldOf, mergeWeekFolds and weekUseAt', () => {
  const resetsAt = WEEK_RESET_S * 1000;
  const NONE: WeekFold = { best: undefined, followedBy: undefined };
  const highBefore = reading('2026-10-15T12:00:40.000Z', 98, '2026-10-15T09:00:00.000Z');
  const undated = reading('2026-10-15T11:59:00.000Z', 98);
  const resetMidWeek = reading('2026-10-15T12:00:30.000Z', 0.4, '2026-10-15T12:00:30.000Z', '2026-10-15T12:00:00.000Z');

  it('keeps the reading that counts and the latest time a reading is known to follow', () => {
    assert.deepEqual(weekFoldOf([highBefore, undated, resetMidWeek], NOW), {
      best: { usedPct: 0.4, resetsAt, at: Date.parse('2026-10-15T12:00:30.000Z'), after: Date.parse('2026-10-15T12:00:00.000Z') },
      followedBy: Date.parse('2026-10-15T12:00:00.000Z'),
    });
    assert.deepEqual(weekFoldOf([], NOW), NONE);
  });

  it('merges folds one snapshot at a time into the fold of them all, in any order', () => {
    const all = weekFoldOf([highBefore, undated, resetMidWeek], NOW);
    const orders = [
      [highBefore, undated, resetMidWeek],
      [resetMidWeek, undated, highBefore],
      [undated, resetMidWeek, highBefore],
    ];
    for (const order of orders) {
      const merged = order.reduce((fold, each) => mergeWeekFolds(fold, weekFoldOf([each], NOW)), NONE);
      assert.deepEqual(merged, all, order.map((each) => each.ts).join(', '));
    }
  });

  it('of the readings no other follows, takes a later week over a higher one, then the higher of one week', () => {
    const fold = (usedPct: number, weekResetsAt: number): WeekFold => ({ best: { usedPct, resetsAt: weekResetsAt, at: NOW - 1 }, followedBy: undefined });
    const nextWeek = resetsAt + 7 * MS_PER_DAY;
    assert.deepEqual(mergeWeekFolds(fold(57, resetsAt), fold(10, nextWeek)), fold(10, nextWeek));
    assert.deepEqual(mergeWeekFolds(fold(60, resetsAt), fold(57, resetsAt)), fold(60, resetsAt));
    assert.deepEqual(mergeWeekFolds(NONE, fold(57, resetsAt)), fold(57, resetsAt));
  });

  it("gives the fold's reading while its week is current, also one dated after now, and none once it reset", () => {
    const takenAfter = weekFoldOf([reading('2026-10-15T12:00:52.000Z', 59, '2026-10-15T12:00:51.000Z')], Date.parse('2026-10-15T12:00:52.000Z'));
    assert.equal(weekUseAt(takenAfter, NOW)?.usedPct, 59, 'a reading folded while the reader read counts');
    assert.equal(weekUseAt(takenAfter, resetsAt - 1)?.usedPct, 59);
    assert.equal(weekUseAt(takenAfter, resetsAt), undefined, 'its week reset');
    assert.equal(weekUseAt(NONE, NOW), undefined);
  });
});

describe('statusLineText', () => {
  const both = snapshot({ rateLimits: { fiveHour: { usedPct: 5.6, resetsAt: NOW }, sevenDay: { usedPct: 57.2, resetsAt: NOW } } });

  it('names the model, where the session works, and the plan windows it knows, the week beside where the pace line stands', () => {
    assert.equal(statusLineText(both, { folder: 'app', branch: 'main', pacePct: 53.4 }), 'Opus 5.5, app on main, week 57% (pace 53%), 5h 6%');
    assert.equal(statusLineText(both, { folder: 'app', branch: 'main' }), 'Opus 5.5, app on main, week 57%, 5h 6%');
    assert.equal(statusLineText(snapshot({ model: null, rateLimits: null }), {}), 'Claude');
  });

  it('shows the pace line only beside a week reading', () => {
    const fiveHourOnly = snapshot({ rateLimits: { fiveHour: { usedPct: 5.6, resetsAt: NOW }, sevenDay: null } });
    assert.equal(statusLineText(fiveHourOnly, { pacePct: 53.4 }), 'Opus 5.5, 5h 6%');
  });

  it('shows a detached HEAD by its commit, a branch over a commit, and each part alone', () => {
    assert.equal(statusLineText(both, { folder: 'app', commit: '1a2b3c4' }), 'Opus 5.5, app at 1a2b3c4, week 57%, 5h 6%');
    assert.equal(statusLineText(both, { branch: 'main', commit: '1a2b3c4' }), 'Opus 5.5, on main, week 57%, 5h 6%');
    assert.equal(statusLineText(both, { folder: 'app' }), 'Opus 5.5, app, week 57%, 5h 6%');
  });

  it('shows the effort level right after the model, or after Claude when the input names no model', () => {
    assert.equal(statusLineText(both, { effort: 'high', folder: 'app', branch: 'main', pacePct: 53.4 }), 'Opus 5.5 (high), app on main, week 57% (pace 53%), 5h 6%');
    assert.equal(statusLineText(snapshot({ model: null, rateLimits: null }), { effort: 'xhigh' }), 'Claude (xhigh)');
  });

  it("colours the meeting tab's whole line and adds the held text last on every other tab", () => {
    const view = { folder: 'app', branch: 'main' };
    assert.equal(
      statusLineText(both, { ...view, meeting: { kind: 'tab', colour: '#d75fd7' } }),
      '\x1b[38;2;215;95;215mOpus 5.5, app on main, week 57%, 5h 6%\x1b[0m',
    );
    assert.equal(
      statusLineText(both, { ...view, meeting: { kind: 'held', text: 'meeting on: held' } }),
      'Opus 5.5, app on main, week 57%, 5h 6%, meeting on: held',
    );
  });
});

describe('effortOfStatus', () => {
  const withEffort = (effort: unknown): string => JSON.stringify({ ...STATUS_INPUT, effort });

  it("reads the effort level Claude Code sends for a model that takes one, kept as sent so a new level shows too", () => {
    assert.equal(effortOfStatus(withEffort({ level: 'high' })), 'high');
    assert.equal(effortOfStatus(`${withEffort({ level: 'turbo' })}\n`), 'turbo');
  });

  it('is undefined without a level: no effort, an empty or non-text level, or an input that is not JSON', () => {
    assert.equal(effortOfStatus(STATUS), undefined);
    assert.equal(effortOfStatus(withEffort({ level: ' ' })), undefined);
    assert.equal(effortOfStatus(withEffort({ level: 3 })), undefined);
    assert.equal(effortOfStatus(withEffort('high')), undefined);
    assert.equal(effortOfStatus('not json'), undefined);
  });

  it('is not kept in the saved snapshot, whose format stays pinned', () => {
    const snapshot = snapshotOfStatus(withEffort({ level: 'high' }), NOW);
    assert.ok(snapshot);
    assert.equal(formatSnapshot(snapshot), STORED);
  });
});

describe('readSnapshots', () => {
  it("reads every session's snapshot in the folder, skipping other files and damaged ones", async () => {
    const files = new MemoryFiles({
      [`/live/${SID}.json`]: STORED,
      [`/live/${OTHER}.json`]: formatSnapshot(snapshot({ sessionId: OTHER })),
      '/live/broken.json': '{"ts":',
      '/live/notes.txt': STORED,
    });
    const read = await readSnapshots(files, '/live');
    assert.deepEqual(read.map((each) => each.sessionId).sort(), [OTHER, SID].sort());
    assert.deepEqual(await readSnapshots(files, '/nowhere'), []);
  });
});

type SweptFiles = Pick<Files, 'list' | 'read' | 'write' | 'remove' | 'modifiedAt'>;

/** A folder whose lists and reads are counted, to see what a sweep walks. */
class CountedFiles implements SweptFiles {
  lists = 0;
  readonly reads: string[] = [];
  private readonly inner: SweptFiles;

  constructor(inner: SweptFiles) {
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
    return this.inner.write(path, text);
  }

  async remove(path: string): Promise<boolean> {
    return this.inner.remove(path);
  }

  async modifiedAt(path: string): Promise<number | undefined> {
    return this.inner.modifiedAt(path);
  }
}

describe('pruneSnapshots', () => {
  const THIRD = '3c9a5e71-2b4d-4f86-a0e3-9d1b7c5f2a48';
  const MARKER = `/live/${SNAPSHOT_PRUNED_FILE}`;
  /** Written exactly 8 days before NOW: kept. */
  const EDGE = new Date(NOW - SNAPSHOT_DAYS_KEPT * MS_PER_DAY).toISOString();
  /** Written one millisecond before the 8 days: removed. */
  const STALE = new Date(NOW - SNAPSHOT_DAYS_KEPT * MS_PER_DAY - 1).toISOString();

  function folder(): MemoryFiles {
    return new MemoryFiles({
      [`/live/${SID}.json`]: formatSnapshot(snapshot({ ts: new Date(NOW).toISOString() })),
      [`/live/${OTHER}.json`]: formatSnapshot(snapshot({ sessionId: OTHER, ts: EDGE })),
      [`/live/${THIRD}.json`]: formatSnapshot(snapshot({ sessionId: THIRD, ts: STALE })),
      '/live/broken.json': '{"ts":',
      '/live/notes.txt': 'kept',
    });
  }

  it('removes the snapshots written more than 8 days ago, leaves newer ones and files that are not snapshots, and stamps the sweep', async () => {
    const files = folder();
    assert.equal(await pruneSnapshots(files, '/live', NOW), 1);
    assert.deepEqual(files.paths(), [MARKER, '/live/broken.json', '/live/notes.txt', `/live/${OTHER}.json`, `/live/${SID}.json`].sort());
    assert.equal(files.get(MARKER), new Date(NOW).toISOString());
    assert.deepEqual((await readSnapshots(files, '/live')).map((each) => each.sessionId).sort(), [OTHER, SID].sort());
  });

  it("removes no reading of the current week: a removed snapshot's week reset within 7 days of it", async () => {
    /** A snapshot `ageMs` old whose reading resets as late as a week can: 7 days after it. */
    const aged = (sessionId: string, ageMs: number, usedPct: number): string => {
      const ts = NOW - ageMs;
      return formatSnapshot(snapshot({ sessionId, ts: new Date(ts).toISOString(), rateLimits: { fiveHour: null, sevenDay: { usedPct, resetsAt: ts + 7 * MS_PER_DAY } } }));
    };
    const files = new MemoryFiles({
      [`/live/${SID}.json`]: aged(SID, 6 * MS_PER_DAY, 40),
      [`/live/${OTHER}.json`]: aged(OTHER, 7 * MS_PER_DAY + 1, 70),
      [`/live/${THIRD}.json`]: aged(THIRD, SNAPSHOT_DAYS_KEPT * MS_PER_DAY + 1, 90),
    });
    const before = weekUseOf(await readSnapshots(files, '/live'), NOW);
    assert.equal(await pruneSnapshots(files, '/live', NOW), 1);
    assert.equal(files.get(`/live/${THIRD}.json`), undefined);
    assert.equal(before?.usedPct, 40);
    assert.deepEqual(weekUseOf(await readSnapshots(files, '/live'), NOW), before);
  });

  it('sweeps at most once an hour, reading only the marker in between', async () => {
    const files = folder();
    await files.write(MARKER, new Date(NOW - SNAPSHOT_PRUNE_EVERY_MS).toISOString());
    const counted = new CountedFiles(files);
    assert.equal(await pruneSnapshots(counted, '/live', NOW - 1), 0);
    assert.deepEqual([counted.lists, counted.reads], [0, [MARKER]]);
    assert.notEqual(files.get(`/live/${THIRD}.json`), undefined);
    assert.equal(await pruneSnapshots(counted, '/live', NOW), 1);
    assert.equal(files.get(`/live/${THIRD}.json`), undefined);
    assert.equal(files.get(MARKER), new Date(NOW).toISOString());
  });

  it("removes a write's temporary siblings left over an hour, and keeps a newer one, which may be a write in flight", async () => {
    const clock = new FakeClock(NOW - SNAPSHOT_TEMPORARY_KEPT_MS - 1);
    const files = new MemoryFiles(
      { [`/live/${OTHER}.json.4242.tmp`]: '', [`/live/${THIRD}.json.4242.7.tmp`]: '{"ts":', [`${MARKER}.4242.8.tmp`]: '', '/live/notes.tmp': 'kept' },
      clock,
    );
    clock.advance(1);
    await files.write(`/live/${SID}.json.5151.1.tmp`, '');
    assert.equal(await pruneSnapshots(files, '/live', NOW), 3);
    assert.deepEqual(files.paths(), [MARKER, '/live/notes.tmp', `/live/${SID}.json.5151.1.tmp`].sort());
  });

  it('sweeps when the marker is damaged or dated after now, as after a clock set back', async () => {
    for (const marker of ['not a time', new Date(NOW + 1).toISOString()]) {
      const files = folder();
      await files.write(MARKER, marker);
      assert.equal(await pruneSnapshots(files, '/live', NOW), 1, marker);
    }
  });

  it('counts only the snapshots this sweep removed, not those another sweep removed first', async () => {
    const files = new MemoryFiles({ [`/live/${THIRD}.json`]: formatSnapshot(snapshot({ sessionId: THIRD, ts: STALE })) });
    const raced: SweptFiles = {
      list: (dir) => files.list(dir),
      read: (path) => files.read(path),
      write: (path, text) => files.write(path, text),
      remove: async (path) => (await files.remove(path)) && files.remove(path),
      modifiedAt: (path) => files.modifiedAt(path),
    };
    assert.equal(await pruneSnapshots(raced, '/live', NOW), 0);
    assert.equal(files.get(`/live/${THIRD}.json`), undefined);
  });

  it('does nothing but stamp a missing folder', async () => {
    const files = new MemoryFiles();
    assert.equal(await pruneSnapshots(files, '/nowhere', NOW), 0);
    assert.deepEqual(files.paths(), [`/nowhere/${SNAPSHOT_PRUNED_FILE}`]);
  });
});

describe('snapshotDirOf', () => {
  it("is the team's setting, relative to its folder, else the kit's live folder", () => {
    const paths = { home: join('/', 'teams', 'web'), kitHome: join('/', 'kit') };
    assert.equal(snapshotDirOf({}, paths), defaultSnapshotDir(paths.kitHome));
    assert.equal(defaultSnapshotDir(paths.kitHome), join(paths.kitHome, 'usage', 'live'));
    assert.equal(snapshotDirOf({ statusSnapshotDir: 'live' }, paths), join(paths.home, 'live'));
    assert.equal(snapshotDirOf({ statusSnapshotDir: join('/', 'snap') }, paths), join('/', 'snap'));
  });
});
