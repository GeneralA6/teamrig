import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatSnapshot, parseSnapshot, readSnapshots, snapshotOfStatus, statusLineText, weekUseOf, type StatusSnapshot } from './snapshot.ts';

const SID = '0b6f9c2e-5d1a-4c3e-9f7a-2e8d4b1c6a90';
const OTHER = '7d2e41a8-93c5-4f60-b1d7-5a9e0c3f8b24';
const NOW = Date.parse('2026-10-15T12:00:50.598Z');
/** Wednesday 2026-10-21 01:00 UTC, in epoch seconds as Claude Code sends it. */
const WEEK_RESET_S = 1792544400;

/** Claude Code's status line input, as much of it as a snapshot keeps and some it does not. */
const STATUS = JSON.stringify({
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
});

/** The pinned file format: a status line of any make that writes this is read by `teamrig budget`. */
const STORED =
  '{"ts":"2026-10-15T12:00:50.598Z","session_id":"0b6f9c2e-5d1a-4c3e-9f7a-2e8d4b1c6a90","cwd":"/work/app",' +
  '"agent_name":"reviewer","model":"Opus 5.5","rate_limits":{"five_hour":{"used_percentage":6,"resets_at":1792081200},' +
  '"seven_day":{"used_percentage":57,"resets_at":1792544400}},"cost_usd":857.79,"context_used_pct":15,"context_input_tokens":153654}';

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    ts: '2026-10-15T12:00:00.000Z',
    sessionId: SID,
    cwd: '/work/app',
    agentName: null,
    model: 'Opus 5.5',
    rateLimits: { fiveHour: null, sevenDay: { usedPct: 57, resetsAt: WEEK_RESET_S * 1000 } },
    costUsd: null,
    contextUsedPct: null,
    contextInputTokens: null,
    ...overrides,
  };
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
      costUsd: null,
      contextUsedPct: null,
      contextInputTokens: null,
    });
  });

  it('refuses a damaged file or one without a time or a valid session id', () => {
    assert.equal(parseSnapshot('{"ts":'), undefined);
    assert.equal(parseSnapshot(JSON.stringify({ session_id: SID })), undefined);
    assert.equal(parseSnapshot(JSON.stringify({ ts: 'yesterday', session_id: SID })), undefined);
    assert.equal(parseSnapshot(JSON.stringify({ ts: '2026-10-15T00:00:00Z', session_id: 'x' })), undefined);
  });
});

describe('weekUseOf', () => {
  const resetsAt = WEEK_RESET_S * 1000;

  it('takes the highest reading of the current week, as a week only grows', () => {
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

describe('statusLineText', () => {
  it('names the model and the plan windows it knows', () => {
    const both = snapshot({ rateLimits: { fiveHour: { usedPct: 5.6, resetsAt: NOW }, sevenDay: { usedPct: 57.2, resetsAt: NOW } } });
    assert.equal(statusLineText(both), 'Opus 5.5, week 57%, 5h 6%');
    assert.equal(statusLineText(snapshot({ model: null, rateLimits: null })), 'Claude');
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
