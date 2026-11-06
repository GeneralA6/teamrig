import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolUseFrom, type CallLine, type PromptLine, type ToolUse, type TranscriptLine } from './line.ts';
import { RollupFold, parseRollupLine, type RollupSource } from './rollup.ts';
import type { DayRollup, TaskRow, UseClass, UseRow } from './rollup-file.ts';
import type { Usage } from './weights.ts';

const NOON = Date.UTC(2026, 10, 2, 12);
const MINUTE = 60_000;
const DAY = '2026-11-02';
const NEXT_DAY = '2026-11-03';
const WORKER: RollupSource = { session: 'a', lead: false, side: false };
const LEAD: RollupSource = { session: 'lead', lead: true, side: false };
const HELPER: RollupSource = { session: 'a', lead: false, side: true };

const usage = (input: number, output = 0): Usage => ({ input, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output });
const shell = (command: string): ToolUse => toolUseFrom('t', 'Bash', { command });
const READ_LIST = shell('teamrig list');
const RUN_BUILD = shell('npm run build');

let keys = 0;
function call(at: number, tools: readonly ToolUse[] = [], fields: Partial<CallLine> = {}): CallLine {
  keys += 1;
  return { kind: 'call', key: `m${keys}|r`, at, mainThread: true, usage: usage(100), tools, ...fields };
}
const prompt = (at: number, pushed = false): PromptLine => ({ kind: 'prompt', at, trigger: 'other', commands: [], ...(pushed ? { pushed: true } : {}) });

function foldOf(source: RollupSource, lines: readonly TranscriptLine[]): ReadonlyMap<string, DayRollup> {
  const fold = new RollupFold();
  const transcript = fold.transcript(source);
  lines.forEach((line) => transcript.line(line));
  transcript.end();
  return fold.rollups();
}

function rowsOf(rollups: ReadonlyMap<string, DayRollup>, day: string = DAY): readonly UseRow[] {
  return rollups.get(day)?.rows ?? [];
}

function tasksOf(rollups: ReadonlyMap<string, DayRollup>, day: string = DAY): readonly TaskRow[] {
  return rollups.get(day)?.tasks ?? [];
}

function classCalls(rollups: ReadonlyMap<string, DayRollup>): Readonly<Partial<Record<UseClass, number>>> {
  return Object.fromEntries(rowsOf(rollups).map((row) => [row.useClass, row.calls]));
}

describe('RollupFold classes', () => {
  it('a pushed turn of nothing but coordination is a coordination-turn', () => {
    assert.deepEqual(classCalls(foldOf(WORKER, [prompt(NOON, true), call(NOON, [READ_LIST]), call(NOON + 1)])), { 'coordination-turn': 2 });
  });

  it('a pushed turn that does work splits by call', () => {
    const rollups = foldOf(WORKER, [prompt(NOON, true), call(NOON, [READ_LIST]), call(NOON + 1, [RUN_BUILD])]);
    assert.deepEqual(classCalls(rollups), { 'coordination-call': 1, work: 1 });
  });

  it('a turn the owner started is never a coordination-turn', () => {
    assert.deepEqual(classCalls(foldOf(WORKER, [prompt(NOON), call(NOON, [READ_LIST])])), { 'coordination-call': 1 });
  });

  it('a call with no tool takes the class before it, and the first starts as coordination', () => {
    const rollups = foldOf(WORKER, [prompt(NOON), call(NOON), call(NOON + 1, [RUN_BUILD]), call(NOON + 2)]);
    assert.deepEqual(classCalls(rollups), { 'coordination-call': 1, work: 2 });
  });

  it('a call is coordination only when every tool in it is, across the lines of its reply', () => {
    const line = call(NOON, [READ_LIST]);
    const rollups = foldOf(WORKER, [prompt(NOON), line, { ...line, tools: [RUN_BUILD] }]);
    assert.deepEqual(classCalls(rollups), { work: 1 });
  });

  it("splits a lead's turn by call, pushed or not", () => {
    const rollups = foldOf(LEAD, [prompt(NOON, true), call(NOON, [READ_LIST]), prompt(NOON + 1), call(NOON + 1, [RUN_BUILD])]);
    assert.deepEqual(classCalls(rollups), { 'lead-coordination': 1, 'lead-work': 1 });
  });

  it('takes a call before any prompt as work, a lead\'s too', () => {
    assert.deepEqual(classCalls(foldOf(WORKER, [call(NOON, [READ_LIST])])), { work: 1 });
    assert.deepEqual(classCalls(foldOf(LEAD, [call(NOON, [READ_LIST])])), { 'lead-work': 1 });
  });

  it("takes every call of a helper's transcript as helper, at no seconds and no turn", () => {
    const rollups = foldOf(HELPER, [prompt(NOON), call(NOON, [READ_LIST]), call(NOON + MINUTE, [RUN_BUILD])]);
    assert.deepEqual(classCalls(rollups), { helper: 2 });
    assert.equal(rowsOf(rollups)[0]?.seconds, 0);
    assert.equal(rowsOf(rollups)[0]?.turns, 0);
  });
});

describe('RollupFold W and tokens', () => {
  it('sums the tokens and rounds each call to whole W', () => {
    const fields = { usage: { input: 3, cacheWrite5m: 1, cacheWrite1h: 1, cacheWriteUnsplit: 1, cacheRead: 11, output: 2 } };
    const [row] = rowsOf(foldOf(WORKER, [prompt(NOON), call(NOON, [RUN_BUILD], fields)]));
    assert.deepEqual(
      { w: row?.w, input: row?.input, cacheWrite: row?.cacheWrite, cacheRead: row?.cacheRead, output: row?.output },
      // 3 + 1.25 + 2 + 2 + 1.1 + 10
      { w: 19, input: 3, cacheWrite: 3, cacheRead: 11, output: 2 },
    );
  });

  it('counts a reply once, adding only the output its later lines add', () => {
    const line = call(NOON, [], { usage: usage(100, 10) });
    const [row] = rowsOf(foldOf(WORKER, [prompt(NOON), line, { ...line, usage: usage(100, 14) }]));
    assert.equal(row?.calls, 1);
    assert.equal(row?.w, 100 + 14 * 5);
    assert.equal(row?.output, 14);
  });

  it('counts a reply two transcripts share once', () => {
    const fold = new RollupFold();
    const line = call(NOON, [RUN_BUILD]);
    for (const source of [WORKER, { ...WORKER, session: 'b' }]) {
      const transcript = fold.transcript(source);
      transcript.line(prompt(NOON));
      transcript.line(line);
      transcript.end();
    }
    assert.deepEqual(rowsOf(fold.rollups()).map((row) => row.session), ['a']);
  });

  it('skips a reply with no time or no W', () => {
    const rollups = foldOf(WORKER, [prompt(NOON), call(NOON, [], { at: undefined }), call(NOON, [], { usage: usage(0) })]);
    assert.equal(rollups.size, 0);
  });

  it('keeps a reply with no key, which nothing can dedupe', () => {
    const line = call(NOON, [RUN_BUILD], { key: undefined });
    assert.equal(rowsOf(foldOf(WORKER, [prompt(NOON), line, line]))[0]?.calls, 2);
  });

  it('rows by model and effort, an unknown one as null', () => {
    const rollups = foldOf(WORKER, [prompt(NOON), call(NOON, [RUN_BUILD], { model: 'm1', effort: 'high' }), call(NOON + 1, [RUN_BUILD])]);
    assert.deepEqual(rowsOf(rollups).map((row) => [row.model, row.effort]), [[null, null], ['m1', 'high']]);
  });

  it('counts a turn once, on the row of its first call', () => {
    const rollups = foldOf(WORKER, [prompt(NOON), call(NOON, [READ_LIST]), call(NOON + 1, [RUN_BUILD]), prompt(NOON + 2), call(NOON + 2, [RUN_BUILD])]);
    assert.deepEqual(rowsOf(rollups).map((row) => [row.useClass, row.turns]), [['coordination-call', 1], ['work', 1]]);
  });
});

describe('RollupFold days and seconds', () => {
  it('charges a call its start to the next call, and the first also from the prompt', () => {
    const [row] = rowsOf(foldOf(WORKER, [prompt(NOON), call(NOON + MINUTE, [RUN_BUILD]), call(NOON + 3 * MINUTE, [RUN_BUILD])]));
    assert.equal(row?.seconds, 180);
  });

  it('caps one call at ten minutes, so an idle gap costs no more than that', () => {
    const [row] = rowsOf(foldOf(WORKER, [prompt(NOON), call(NOON, [RUN_BUILD]), call(NOON + 60 * MINUTE, [RUN_BUILD])]));
    assert.equal(row?.seconds, 600);
  });

  it('charges nothing from one turn into the next', () => {
    const [row] = rowsOf(foldOf(WORKER, [prompt(NOON), call(NOON, [RUN_BUILD]), prompt(NOON + 5 * MINUTE), call(NOON + 5 * MINUTE, [RUN_BUILD])]));
    assert.equal(row?.seconds, 0);
  });

  it('puts each call of a turn across midnight on its own UTC day', () => {
    const lateAt = Date.UTC(2026, 10, 2, 23, 59);
    const rollups = foldOf(WORKER, [prompt(lateAt), call(lateAt, [RUN_BUILD]), call(lateAt + 2 * MINUTE, [RUN_BUILD])]);
    assert.deepEqual([...rollups.keys()], [DAY, NEXT_DAY]);
    assert.equal(rowsOf(rollups, NEXT_DAY)[0]?.turns, 0);
  });

  it('gives the same rows whatever order the sessions come in', () => {
    const lines = (): readonly TranscriptLine[] => [prompt(NOON), call(NOON, [RUN_BUILD])];
    const twice = (sessions: readonly string[]): readonly UseRow[] => {
      const fold = new RollupFold();
      for (const session of sessions) {
        const transcript = fold.transcript({ ...WORKER, session });
        lines().forEach((line) => transcript.line(line));
        transcript.end();
      }
      return rowsOf(fold.rollups());
    };
    assert.deepEqual(twice(['b', 'a']).map((row) => row.session), twice(['a', 'b']).map((row) => row.session));
  });
});

describe('RollupFold tasks', () => {
  const NAMES_TWO = shell('teamrig test --session a --task T1 -- npm test; git -C .worktrees/t2-x status');

  it('leaves coordination out of the task rows, so they add up to the task work', () => {
    const rollups = foldOf(WORKER, [prompt(NOON), call(NOON, [shell('teamrig set T1 --status done')]), call(NOON + 1, [shell('npm run build T1')])]);
    const work = rowsOf(rollups).filter((row) => row.useClass === 'work');
    assert.equal(tasksOf(rollups).reduce((sum, row) => sum + row.w, 0), work.reduce((sum, row) => sum + row.w, 0));
  });

  it('holds a turn that names no task as a null row', () => {
    assert.deepEqual(tasksOf(foldOf(WORKER, [prompt(NOON), call(NOON, [RUN_BUILD])])), [{ session: 'a', task: null, w: 100, seconds: 0 }]);
  });

  it('splits a turn equally over its tasks in whole W that add up', () => {
    const rows = tasksOf(foldOf(WORKER, [prompt(NOON), call(NOON, [NAMES_TWO], { usage: usage(101) })]));
    assert.deepEqual(rows.map((row) => row.w).sort((a, b) => a - b), [50, 51]);
  });

  it('charges the coordination turn nothing', () => {
    assert.deepEqual(tasksOf(foldOf(WORKER, [prompt(NOON, true), call(NOON, [shell('teamrig set T1 --status done')])])), []);
  });

  it("charges a helper's work to the tasks its own transcript names", () => {
    const rows = tasksOf(foldOf(HELPER, [prompt(NOON), call(NOON, [shell('git -C .worktrees/t3-x status')])]));
    assert.deepEqual(rows, [{ session: 'a', task: 'T3', w: 100, seconds: 0 }]);
  });
});

describe('parseRollupLine', () => {
  const meta = (text: string, isMeta: boolean): string =>
    JSON.stringify({ type: 'user', isMeta, timestamp: '2026-11-02T12:00:00.000Z', message: { role: 'user', content: text } });

  it("reads the Stop hook's meta line as a pushed prompt", () => {
    const line = parseRollupLine(meta('Stop hook feedback: go on', true));
    assert.equal(line?.kind, 'prompt');
    assert.equal(line?.kind === 'prompt' ? line.pushed : undefined, true);
  });

  it('drops any other meta line, and reads a plain prompt as the meter does', () => {
    assert.equal(parseRollupLine(meta('Caveat: local commands', true)), undefined);
    assert.equal(parseRollupLine(meta('fix the table', false))?.kind, 'prompt');
    assert.equal(parseRollupLine('not json'), undefined);
  });
});
