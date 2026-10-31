import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockStartLines } from '../hooks/live-tasks.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import {
  promptLine,
  replyLine,
  resultsLine,
  compactLine,
  sessionStartNoteLine,
  transcript,
  type FixtureReply,
  type FixtureResult,
  type FixtureTool,
} from '../testing/transcript-lines.ts';
import type { TranscriptSet } from './discover.ts';
import { runMeter, type MeterResult } from './meter.ts';
import { PATTERN_FIELDS } from './patterns.ts';
import { RECENT_KEYS_KEPT, UsageStore, type DayUsage, type UsageState } from './store.ts';
import { NO_TURN } from './tasks.ts';

const MAIN = '/t/p/alpha.jsonl';
const SUB = '/t/p/alpha/subagents/agent-a1.jsonl';
const BOTH: TranscriptSet = { main: [MAIN], subagents: [SUB] };
const DIR = '/state/usage';
const SESSION = 'alpha';
const DAY = '2026-03-02';
const DAY_BEFORE = '2026-03-01';

function at(hour: number, minute = 0, second = 0): string {
  return new Date(Date.UTC(2026, 2, 2, hour, minute, second)).toISOString();
}

function before(hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 2, 1, hour, minute)).toISOString();
}

function near(actual: number | undefined, expected: number, label = ''): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${label} ${actual} is not ${expected}`);
}

/** A meter over in-memory transcripts and usage files, its clock at `now`. */
function world(now: string, transcripts: Readonly<Record<string, string>> = {}): {
  bytes: MemoryTranscripts;
  files: MemoryFiles;
  clock: FakeClock;
  run: (maxBytes?: number, transcripts?: TranscriptSet, subagentWeight?: number) => Promise<MeterResult>;
} {
  const bytes = new MemoryTranscripts(transcripts);
  const files = new MemoryFiles();
  const clock = new FakeClock(now);
  const store = new UsageStore(files, DIR);
  return {
    bytes,
    files,
    clock,
    run: (maxBytes = 10_000_000, transcripts = BOTH, subagentWeight = 1) =>
      runMeter({ bytes, store, clock }, { session: SESSION, transcripts, subagentWeight, maxBytes }),
  };
}

function day(state: UsageState, name: string): DayUsage | undefined {
  return state.byDay[name];
}

// W of the fixture replies: input + 2 per unsplit cache write + 0.1 per cache read + 5 per output token.
const R1: FixtureReply = { id: 'm1', requestId: 'q1', at: at(9, 1), usage: { input: 10, cacheWrite: 100, cacheRead: 1_000, output: 10 }, tools: [{ id: 't1', name: 'Read' }] };
const R1_MORE: FixtureReply = { ...R1, at: at(9, 1, 5), usage: { ...R1.usage, output: 50 }, tools: [{ id: 't2', name: 'Grep' }] };
const R1_W = 10 + 200 + 100 + 50 * 5;
const R2: FixtureReply = { id: 'm2', requestId: 'q2', at: at(9, 2), usage: { input: 4, cacheRead: 2_000, output: 20 } };
const R2_W = 4 + 200 + 100;
const S1: FixtureReply = { id: 's1', requestId: 'qs', at: at(9, 3), sidechain: true, usage: { input: 1, cacheWrite5m: 8, cacheWrite: 8, output: 2 } };
const S1_W = 1 + 10 + 10;

describe('runMeter', () => {
  it('counts each reply once, main thread and subagent, on the UTC day it began', async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([promptLine(at(9)), replyLine(R1), replyLine(R1_MORE), resultsLine(at(9, 1, 6), [{ id: 't1', text: 'x' }]), replyLine(R2), compactLine(at(9, 4))]),
      [SUB]: transcript([promptLine(at(9, 2), 'task', true), replyLine(S1)]),
    });
    const result = await meter.run();
    assert.equal(result.saved, true);
    assert.equal(result.catchingUp, false);
    near(day(result.state, DAY)?.w, R1_W + R2_W + S1_W);
    assert.equal(day(result.state, DAY)?.calls, 3);
    const patterns = day(result.state, DAY)?.patterns;
    assert.deepEqual([patterns?.otherTurns, patterns?.subagentTurns, patterns?.compactions], [1, 1, 1]);
    near(patterns?.otherW, R1_W + R2_W, 'main thread W');
    near(patterns?.subagentW, S1_W, 'subagent W');
    assert.equal(result.bytesRead, (await meter.bytes.size(MAIN) ?? 0) + (await meter.bytes.size(SUB) ?? 0));
    const again = await meter.run();
    assert.equal(again.bytesRead, 0);
    assert.deepEqual(again.state.byDay, result.state.byDay);
  });

  it("counts a subagent's W at the subagent weight, its added output and its turn's W too", async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([promptLine(at(9)), replyLine(R1), replyLine(R1_MORE), replyLine(R2)]),
      [SUB]: transcript([promptLine(at(9, 2), 'task', true), replyLine(S1), replyLine({ ...S1, at: at(9, 3, 5), usage: { ...S1.usage, output: 6 } })]),
    });
    const state = (await meter.run(10_000_000, BOTH, 2.5)).state;
    const subagentW = 2.5 * (S1_W + 4 * 5);
    near(day(state, DAY)?.w, R1_W + R2_W + subagentW);
    near(day(state, DAY)?.patterns.otherW, R1_W + R2_W, 'main thread W');
    near(day(state, DAY)?.patterns.subagentW, subagentW, 'subagent W');
  });

  it("splits a turn's W equally over the tasks its calls name once the next prompt ends it; a turn naming none stays unattributed", async () => {
    const naming: FixtureReply = { ...R2, tools: [{ id: 'b1', name: 'Bash', command: 'teamrig set T5 && git -C .worktrees/t6-meter log' }] };
    const meter = world(at(12), {
      [MAIN]: transcript([promptLine(at(9)), replyLine(R1), replyLine(R1_MORE), replyLine(naming), promptLine(at(9, 5)), replyLine({ id: 'm3', requestId: 'q3', at: at(9, 6), usage: { input: 7 } }), promptLine(at(9, 7))]),
    });
    const state = (await meter.run(10_000_000, { main: [MAIN], subagents: [] })).state;
    assert.deepEqual(Object.keys(state.byTask[DAY] ?? {}), ['T5', 'T6']);
    near(state.byTask[DAY]?.['T5'], (R1_W + R2_W) / 2, 'T5');
    near(state.byTask[DAY]?.['T6'], (R1_W + R2_W) / 2, 'T6');
    near(day(state, DAY)?.w, R1_W + R2_W + 7);
  });

  it("holds an open turn's W in its transcript's position across runs, out of byTask until the next prompt", async () => {
    const meter = world(at(12), { [MAIN]: transcript([promptLine(at(9)), replyLine(R1)]) });
    const mainOnly: TranscriptSet = { main: [MAIN], subagents: [] };
    const first = (await meter.run(10_000_000, mainOnly)).state;
    assert.deepEqual(first.byTask, {});
    assert.deepEqual(first.cursors[MAIN]?.turn.tasks, []);
    near(first.cursors[MAIN]?.turn.held[DAY], R1_W - 40 * 5, 'held');
    meter.bytes.append(MAIN, transcript([replyLine(R1_MORE), replyLine({ ...R2, tools: [{ id: 'b1', name: 'Bash', command: 'teamrig show T5' }] }), promptLine(at(9, 5))]));
    const second = (await meter.run(10_000_000, mainOnly)).state;
    near(second.byTask[DAY]?.['T5'], R1_W + R2_W, 'T5');
    assert.deepEqual(second.cursors[MAIN]?.turn, NO_TURN);
  });

  it("charges no task with a subagent's W, whatever its calls name", async () => {
    const meter = world(at(12), {
      [SUB]: transcript([promptLine(at(9, 2), 'task', true), replyLine({ ...S1, tools: [{ id: 'b2', name: 'Bash', command: 'teamrig show T7' }] }), promptLine(at(9, 4), 'next', true)]),
    });
    const state = (await meter.run()).state;
    near(day(state, DAY)?.w, S1_W);
    assert.deepEqual(state.byTask, {});
  });

  it('skips a reply logged twice, in another file or later in the same one, and a reply without a time', async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([replyLine(R1), replyLine(R2), replyLine({ ...R1_MORE, at: at(9, 5) }), replyLine({ id: 'm3', usage: { input: 1_000 } })]),
      [SUB]: transcript([replyLine({ ...R2, sidechain: true })]),
    });
    const result = await meter.run();
    near(day(result.state, DAY)?.w, R1_W - 40 * 5 + R2_W);
    assert.equal(day(result.state, DAY)?.calls, 2);
  });

  it('remembers only the latest call keys, so a repeat older than that counts again', async () => {
    const reply = (index: number): string => replyLine({ id: `m${index}`, at: at(9), usage: { input: 1 } });
    const lines = Array.from({ length: RECENT_KEYS_KEPT + 1 }, (_, index) => reply(index));
    const meter = world(at(12), { [MAIN]: transcript([...lines, reply(0), reply(RECENT_KEYS_KEPT)]) });
    const result = await meter.run();
    assert.equal(day(result.state, DAY)?.calls, RECENT_KEYS_KEPT + 2);
    assert.equal(result.state.recentKeys.length, RECENT_KEYS_KEPT);
  });

  it('counts unkeyed replies each time', async () => {
    const unkeyed: FixtureReply = { at: at(9), usage: { input: 3 } };
    const meter = world(at(12), { [MAIN]: transcript([replyLine(unkeyed), replyLine(unkeyed)]) });
    near(day((await meter.run()).state, DAY)?.w, 6);
  });

  it('leaves a torn last line for the next run and counts it once', async () => {
    const whole = replyLine(R2);
    const meter = world(at(12), { [MAIN]: `${transcript([replyLine(R1)])}${whole.slice(0, 40)}` });
    const first = await meter.run();
    near(day(first.state, DAY)?.w, R1_W - 40 * 5);
    meter.bytes.append(MAIN, `${whole.slice(40)}\n`);
    const second = await meter.run();
    near(day(second.state, DAY)?.w, R1_W - 40 * 5 + R2_W);
    assert.equal(day(second.state, DAY)?.calls, 2);
  });

  it("reads a new transcript from today's first line", async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([replyLine({ ...R1, at: before(10) }), replyLine({ ...R2, at: before(23, 59) }), promptLine(at(8)), replyLine({ id: 'm4', at: at(9), usage: { input: 7 } })]),
    });
    const result = await meter.run();
    assert.deepEqual(Object.keys(result.state.byDay), [DAY]);
    near(day(result.state, DAY)?.w, 7);
  });

  it('adds output a reply gains after midnight to the day and hour the reply began', async () => {
    const late: FixtureReply = { id: 'y1', requestId: 'qy', at: before(23, 59), usage: { input: 1, output: 10 } };
    const meter = world(before(23, 59), { [MAIN]: transcript([replyLine(late)]) });
    await meter.run();
    meter.bytes.append(MAIN, transcript([replyLine({ ...late, at: at(0, 0, 5), usage: { input: 1, output: 30 } }), replyLine({ id: 't1', at: at(0, 1), usage: { input: 2 } })]));
    meter.clock.advance(8 * 3_600_000);
    const result = await meter.run();
    near(day(result.state, DAY_BEFORE)?.w, 1 + 30 * 5);
    assert.equal(day(result.state, DAY_BEFORE)?.calls, 1);
    near(day(result.state, DAY)?.w, 2);
    assert.deepEqual(result.state.byHour, { '2026-03-01T23': 1 + 30 * 5, '2026-03-02T00': 2 });
  });

  it('counts each call to the UTC hour it began, so the hours of a day sum to its W', async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([replyLine(R1), replyLine(R1_MORE), replyLine({ ...R2, at: at(10, 59, 59) })]),
      [SUB]: transcript([replyLine({ ...S1, at: at(11) })]),
    });
    const state = (await meter.run()).state;
    assert.deepEqual(state.byHour, { '2026-03-02T09': R1_W, '2026-03-02T10': R2_W, '2026-03-02T11': S1_W });
    near(day(state, DAY)?.w, R1_W + R2_W + S1_W);
  });

  it('adds the output of a call stored before hours were counted to its day alone', async () => {
    const first: FixtureReply = { ...R1, usage: { ...R1.usage, output: 10 } };
    const meter = world(at(12), { [MAIN]: transcript([replyLine(first)]) });
    await meter.run(10_000_000, { main: [MAIN], subagents: [] });
    const file = `${DIR}/${SESSION}.json`;
    const saved = await meter.files.read(file);
    assert.ok(saved !== undefined);
    await meter.files.write(file, saved.replace(',"hour":"2026-03-02T09"', ''));
    meter.bytes.append(MAIN, transcript([replyLine(R1_MORE)]));
    const state = (await meter.run(10_000_000, { main: [MAIN], subagents: [] })).state;
    near(day(state, DAY)?.w, R1_W);
    assert.deepEqual(state.byHour, { '2026-03-02T09': R1_W - 40 * 5 });
  });

  it('reads at most the byte limit per run, catching up over the next runs', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => replyLine({ id: `m${index}`, at: at(9, index), usage: { input: 5 } }));
    const meter = world(at(12), { [MAIN]: transcript(lines) });
    const first = await meter.run(1_000);
    assert.equal(first.catchingUp, true);
    assert.ok(first.bytesRead <= 1_000 && first.bytesRead > 0);
    let runs = 1;
    let last = first;
    while (last.catchingUp) {
      last = await meter.run(1_000);
      runs += 1;
    }
    assert.ok(runs > 5, `${runs} runs`);
    near(day(last.state, DAY)?.w, 200);
    assert.equal(day(last.state, DAY)?.calls, 40);
  });

  it('keeps a transcript the limit did not reach for the next run, its start already found', async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([replyLine(R1), replyLine(R2)]),
      [SUB]: transcript([replyLine({ ...S1, at: before(9) }), replyLine(S1)]),
    });
    const result = await meter.run(10);
    assert.equal(result.catchingUp, true);
    const sub = result.state.cursors[SUB];
    assert.equal(sub?.offset, Buffer.byteLength(transcript([replyLine({ ...S1, at: before(9) })])));
    near(day(result.state, DAY)?.w, R1_W - 40 * 5);
    const next = await meter.run();
    near(day(next.state, DAY)?.w, R1_W - 40 * 5 + R2_W + S1_W);
  });

  it('reads a transcript that shrank again from the first line of today, and skips a missing one', async () => {
    const meter = world(at(12), { [MAIN]: transcript([replyLine(R1), replyLine(R2)]) });
    await meter.run();
    meter.bytes.set(MAIN, transcript([replyLine({ id: 'n1', at: at(10), usage: { input: 9 } })]));
    const result = await meter.run(10_000_000, { main: [MAIN, '/t/p/gone.jsonl'], subagents: [] });
    near(day(result.state, DAY)?.w, R1_W - 40 * 5 + R2_W + 9);
    assert.equal(result.state.cursors['/t/p/gone.jsonl'], undefined);
  });

  it('writes nothing when another run saved first, and the next run counts what it missed', async () => {
    const files = new RacingFiles();
    const bytes = new MemoryTranscripts({ [MAIN]: transcript([replyLine(R1)]) });
    const clock = new FakeClock(at(12));
    const store = new UsageStore(files, DIR);
    const run = (): Promise<MeterResult> => runMeter({ bytes, store, clock }, { session: SESSION, transcripts: { main: [MAIN], subagents: [] }, subagentWeight: 1, maxBytes: 10_000 });
    files.race = async () => {
      await run();
      bytes.append(MAIN, transcript([replyLine(R2)]));
    };
    const lost = await run();
    assert.equal(lost.saved, false);
    near(day(lost.state, DAY)?.w, R1_W - 40 * 5);
    const stored = await store.load(SESSION);
    assert.equal(stored.rev, 1);
    near(day(stored.state, DAY)?.w, R1_W - 40 * 5);
    const next = await run();
    assert.equal(next.saved, true);
    near(day(next.state, DAY)?.w, R1_W - 40 * 5 + R2_W);
    assert.equal(day(next.state, DAY)?.calls, 2);
  });

  it('drops days and positions past their keep window', async () => {
    const meter = world(before(9), { [MAIN]: transcript([replyLine({ id: 'old', at: before(8), usage: { input: 1 } })]) });
    await meter.run();
    meter.clock.advance(9 * 86_400_000);
    const result = await meter.run(10_000_000, { main: [], subagents: [SUB] });
    assert.deepEqual(result.state.byDay, {});
    assert.deepEqual(result.state.byHour, {});
    assert.deepEqual(result.state.cursors, {});
  });

  it('counts the same totals, patterns and task W read in many small runs as in one', async () => {
    const main = loopTranscript('m', 0);
    const sub = loopTranscript('s', 30, true);
    const whole = world(at(23), { [MAIN]: main, [SUB]: sub });
    const once = await whole.run();
    const pieces = world(at(23), { [MAIN]: main, [SUB]: sub });
    let result = await pieces.run(900);
    let runs = 1;
    while (result.catchingUp) {
      result = await pieces.run(900);
      runs += 1;
    }
    assert.ok(runs > 20, `${runs} runs`);
    const expected = day(once.state, DAY);
    const actual = day(result.state, DAY);
    near(actual?.w, expected?.w ?? -1, 'w');
    assert.equal(actual?.calls, expected?.calls);
    for (const field of PATTERN_FIELDS) {
      near(actual?.patterns[field], expected?.patterns[field] ?? -1, field);
    }
    const patterns = expected?.patterns;
    const counted = ['readChain', 'editChain', 'editThenTest', 'editTestJoined', 'rerunFailedPiped', 'rerunFailedFull', 'rerunAfterPass', 'passRuns'] as const;
    for (const field of [...counted, 'missCalls', 'workBlocks', 'missNoStart', 'heavySteps', 'missHeavyOutside'] as const) {
      assert.ok((patterns?.[field] ?? 0) > 0, `${field} never counted`);
    }
    const tasks = once.state.byTask[DAY] ?? {};
    assert.deepEqual(Object.keys(tasks).sort(), ['T1', 'T2', 'T3', 'T9']);
    for (const [task, w] of Object.entries(tasks)) {
      near(result.state.byTask[DAY]?.[task], w, task);
    }
    assert.deepEqual(result.state.cursors[MAIN]?.turn.tasks, ['T4', 'T9']);
    near(result.state.cursors[MAIN]?.turn.held[DAY], once.state.cursors[MAIN]?.turn.held[DAY] ?? -1, 'open turn');
  });

  it('counts rule misses on the day: a work block with no teamrig start in its first calls, a plain git worktree remove', async () => {
    const replies = (prefix: string, hour: number, count: number, command: string | undefined): string[] =>
      Array.from({ length: count }, (_, index) =>
        replyLine({
          id: `${prefix}${index}`,
          requestId: `q${prefix}${index}`,
          at: at(hour, index + 1),
          usage: { input: 1, output: 1 },
          tools: command === undefined ? [] : [{ id: `t${prefix}${index}`, name: 'Bash', command }],
        }),
      );
    const meter = world(at(23), {
      [MAIN]: transcript([promptLine(at(9)), ...replies('a', 9, 1, 'teamrig start --session alpha'), promptLine(at(11)), ...replies('b', 11, 10, 'git worktree remove .worktrees/x')]),
    });
    const result = await meter.run(10_000_000, { main: [MAIN], subagents: [] });
    const patterns = day(result.state, DAY)?.patterns;
    assert.deepEqual([patterns?.missCalls, patterns?.workBlocks, patterns?.missNoStart, patterns?.worktreeRemoves, patterns?.missGitWorktreeRemove], [11, 2, 1, 10, 10]);
    assert.deepEqual(result.state.cursors[MAIN]?.misses, { lastAt: Date.parse(at(11, 10)), block: null, noted: false });
  });

  it("takes a fresh start's SessionStart note as its work block's teamrig start (T1529)", async () => {
    const note = sessionStartNoteLine(at(9), ['# Team rules', blockStartLines('alpha', { at: 'Mon 03-02 09:00 UTC', meetings: undefined, week: undefined }, 'teamrig').join('\n')]);
    const replies = Array.from({ length: 10 }, (_, index) =>
      replyLine({ id: `n${index}`, requestId: `qn${index}`, at: at(9, index + 1), usage: { input: 1, output: 1 }, tools: [{ id: `tn${index}`, name: 'Bash', command: 'git status' }] }),
    );
    const meter = world(at(23), { [MAIN]: transcript([note, promptLine(at(9)), ...replies]) });
    const result = await meter.run(10_000_000, { main: [MAIN], subagents: [] });
    const patterns = day(result.state, DAY)?.patterns;
    assert.deepEqual([patterns?.missCalls, patterns?.workBlocks, patterns?.missNoStart], [10, 1, 0]);
  });

  it('counts a results line with no reply open to the day it was written', async () => {
    const meter = world(at(12), {
      [MAIN]: transcript([promptLine(at(9)), resultsLine(at(9, 1), [{ id: 'x', text: 'ok' }]), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'y', content: 'ok' }] } })]),
    });
    const result = await meter.run();
    assert.equal(result.state.cursors[MAIN]?.offset, await meter.bytes.size(MAIN));
  });
});

/** Files whose second read runs `race` first: another run that loads and saves between this run's load and save. */
class RacingFiles extends MemoryFiles {
  race: (() => Promise<void>) | undefined;
  private reads = 0;

  override async read(path: string): Promise<string | undefined> {
    this.reads += 1;
    const race = this.race;
    if (this.reads === 2 && race !== undefined) {
      this.race = undefined;
      await race();
    }
    return super.read(path);
  }
}

/**
 * A transcript of several turns that shows every loop pattern: chained lookups and edits, a test
 * right after an edit and one joined with it, failing re-runs piped and in full, a re-run after a
 * pass, passing output that stays in the context, a compaction that drops it, and replies split
 * over two lines. Times start at `startMinute` past 10:00.
 */
function loopTranscript(prefix: string, startMinute: number, sidechain = false): string {
  const lines: string[] = [];
  let minute = startMinute;
  let call = 0;
  let context = 20_000;
  const stamp = (): string => new Date(Date.UTC(2026, 2, 2, 10, minute++)).toISOString();
  const reply = (tools: readonly FixtureTool[], results: readonly FixtureResult[] = [], split = false): void => {
    call += 1;
    context += 1_500;
    const id = `${prefix}${call}`;
    const base: FixtureReply = { id, requestId: `r${id}`, at: stamp(), sidechain, usage: { input: 3, cacheWrite: 1_500, cacheRead: context, output: 40 }, tools: tools.slice(0, 1) };
    lines.push(replyLine(base));
    if (split || tools.length > 1) {
      lines.push(replyLine({ ...base, usage: { ...base.usage, output: 90 }, tools: tools.slice(1) }));
    }
    if (results.length > 0) {
      lines.push(resultsLine(stamp(), results, sidechain));
    }
  };
  const pass = `ℹ pass 40\nℹ fail 0\n${'ok\n'.repeat(60)}`;
  const fail = 'ℹ pass 39\nℹ fail 1\nnot ok 7 - case';
  for (let turn = 0; turn < 4; turn += 1) {
    lines.push(promptLine(stamp(), `turn ${turn}`, sidechain));
    reply([{ id: `${prefix}${turn}a`, name: 'Read' }], [], true);
    reply([{ id: `${prefix}${turn}b`, name: 'Grep' }]);
    reply([{ id: `${prefix}${turn}c`, name: 'Edit' }]);
    reply([{ id: `${prefix}${turn}d`, name: 'Edit' }]);
    reply([{ id: `${prefix}${turn}e`, name: 'Bash', command: 'npm test 2>&1 | tail -20' }], [{ id: `${prefix}${turn}e`, text: fail }]);
    reply([{ id: `${prefix}${turn}f`, name: 'Bash', command: 'npm test' }], [{ id: `${prefix}${turn}f`, text: fail, isError: true }]);
    reply([{ id: `${prefix}${turn}g`, name: 'Bash', command: 'npm test' }], [{ id: `${prefix}${turn}g`, text: pass }]);
    reply([{ id: `${prefix}${turn}h`, name: 'Bash', command: 'node --test src/a.test.ts' }], [{ id: `${prefix}${turn}h`, text: pass }]);
    reply([
      { id: `${prefix}${turn}i`, name: 'Edit' },
      { id: `${prefix}${turn}j`, name: 'Bash', command: 'npm test' },
    ]);
    lines.push(compactLine(stamp()));
    context = 8_000;
    reply([{ id: `${prefix}${turn}k`, name: 'Read' }]);
    reply([{ id: `${prefix}${turn}l`, name: 'Bash', command: `teamrig show T${turn + 1} T9` }]);
  }
  return transcript(lines);
}
