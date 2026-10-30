import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolUse } from './line.ts';
import { BLOCK_IDLE_MS, INITIAL_MISS_STATE, MissTracker, parseMissState, START_WITHIN_CALLS, toolMissesOf, type MissState } from './misses.ts';
import type { Count, PatternField } from './patterns.ts';

function bash(command: string): ToolUse {
  return { id: 't', name: 'Bash', command };
}

/** A tool call's counters as `start` (when it runs `teamrig start`) then its fields, space-separated. */
function missesOf(tool: ToolUse): string {
  const { starts, counts } = toolMissesOf(tool);
  return [...(starts ? ['start'] : []), ...counts].join(' ');
}

function expectMisses(cases: Readonly<Record<string, string>>): void {
  for (const [command, expected] of Object.entries(cases)) {
    assert.equal(missesOf(bash(command)), expected, command);
  }
}

describe('toolMissesOf', () => {
  it('counts every worktree remove, and a plain git one as a miss', () => {
    expectMisses({
      'git worktree remove .worktrees/t1': 'worktreeRemoves missGitWorktreeRemove',
      'git -C C:/repo worktree remove --force .worktrees/t1': 'worktreeRemoves missGitWorktreeRemove',
      'teamrig worktree remove .worktrees/t1 --delete-branch': 'worktreeRemoves',
      'git worktree list': '',
      'git worktree add .worktrees/t1 -b t1 origin/main': '',
    });
  });

  it('counts --followups none on verifying or done, and a miss when its own note or evidence names work left', () => {
    expectMisses({
      'teamrig set T1 --status done --followups none --note "shipped" --evidence "PR #5 merged"': 'followupsNone',
      'teamrig set T1 --status done --followups none --note "docs follow-up not yet built"': 'followupsNone missFollowupWords',
      'teamrig set T1 --status=verifying --followups=none --evidence="still to prove it live"': 'followupsNone missFollowupWords',
      'teamrig set T1 --status done --followups none --note "next steps: none"': 'followupsNone missFollowupWords',
      'teamrig set T1 --status done --followups T2 --note "follow-up is T2"': '',
      'teamrig set T1 --status waiting --note "todo"': '',
      'teamrig add --owner a --title "todo: set --status done --followups none"': '',
    });
  });

  it('counts an npx or dlx that fetches a package, never one that runs an installed bin', () => {
    expectMisses({
      'npx cowsay@1.2.3 hi': 'missAdHocFetch',
      'pnpm dlx create-vite app': 'missAdHocFetch',
      'npm create vite@5 app': 'missAdHocFetch',
      'npx eslint src': '',
    });
  });

  it('counts tests and builds, and a miss when no teamrig queue or test runs them', () => {
    expectMisses({
      'npm test': 'heavySteps missHeavyOutside',
      'npm run build': 'heavySteps missHeavyOutside',
      'pnpm run test:cli -- --watch=false': 'heavySteps missHeavyOutside',
      'yarn typecheck': 'heavySteps missHeavyOutside',
      'npx vitest run src/a.test.ts': 'heavySteps missHeavyOutside',
      'node --test src/a.test.ts': 'heavySteps missHeavyOutside',
      'cd app && tsc --noEmit': 'heavySteps missHeavyOutside',
      'teamrig queue --session a --what "checks" -- npm run check': 'heavySteps',
      'teamrig queue --session a --what "tests" -- teamrig test --session a -- npm test': 'heavySteps',
      'teamrig test --session a -- node --test src/a.test.ts': 'heavySteps',
      'teamrig queue --session a --what "x" -- "npm run lint && npm test"': 'heavySteps',
      'teamrig queue --session a --what "x" -- npm test && npm run build': 'heavySteps missHeavyOutside',
      'npm install': '',
      'npm run dev': '',
      'node scripts/build-report.ts': '',
    });
  });

  it('counts a test run under teamrig heavy, the old name of queue in transcripts from before the rename, as no miss', () => {
    expectMisses({
      'teamrig heavy --session a --what "checks" -- npm run check': 'heavySteps',
      'teamrig heavy --session a --what "x" -- npm test && npm run build': 'heavySteps missHeavyOutside',
    });
  });

  it('reads a command, never text that only quotes one', () => {
    expectMisses({
      'git commit -m "never run git worktree remove or npm test by hand"': '',
      "cat > notes.md <<'EOF'\nnpm test\ngit worktree remove x\nEOF": '',
      'echo "teamrig start --session a"': '',
    });
  });

  it('marks teamrig start, alone or after other steps', () => {
    expectMisses({
      'teamrig start --session a': 'start',
      'teamrig start --session a && teamrig inbox read --session a': 'start',
      'teamrig list --session a': '',
    });
  });

  it('reads PowerShell commands, and counts nothing for a tool that runs no shell', () => {
    assert.equal(missesOf({ id: 't', name: 'PowerShell', command: 'npm test' }), 'heavySteps missHeavyOutside');
    assert.equal(missesOf({ id: 't', name: 'Read', command: undefined, path: '/a/npm test' }), '');
    assert.equal(missesOf({ id: 't', name: 'Grep', command: 'npm test' }), '');
  });
});

const DAY = '2026-10-19';
const NEXT_DAY = '2026-10-20';
const AT = Date.parse('2026-10-19T08:00:00Z');
const MINUTE = 60_000;

/** A tracker counting into per-day maps, as the meter's tally does. */
function tracked(state: MissState = INITIAL_MISS_STATE): { tracker: MissTracker; counts: Map<string, Partial<Record<PatternField, number>>> } {
  const counts = new Map<string, Partial<Record<PatternField, number>>>();
  const counterOf = (day: string | undefined): Count => {
    if (day === undefined) {
      return () => undefined;
    }
    return (field, amount) => {
      const totals = counts.get(day) ?? {};
      totals[field] = (totals[field] ?? 0) + amount;
      counts.set(day, totals);
    };
  };
  return { tracker: new MissTracker(state, counterOf), counts };
}

/** `count` calls a minute apart from `from`, each running `command` (none when undefined); returns the minute after the last. */
function calls(tracker: MissTracker, count: number, from: number, command?: string, day = DAY): number {
  for (let index = 0; index < count; index += 1) {
    tracker.callStarted(command === undefined ? [] : [bash(command)], from + index * MINUTE, day);
  }
  return from + count * MINUTE;
}

describe('MissTracker', () => {
  it("counts a work block whose teamrig start came within its first calls, on the block's day", () => {
    const { tracker, counts } = tracked();
    tracker.prompt('owner', AT, DAY);
    const after = calls(tracker, 2, AT + MINUTE);
    tracker.callStarted([bash('teamrig start --session a')], after, DAY);
    assert.deepEqual(counts.get(DAY), { missCalls: 3, workBlocks: 1 });
    assert.equal(tracker.state().block, null);
  });

  it(`counts a miss when the first ${START_WITHIN_CALLS} calls run no teamrig start, and nothing for a shorter block`, () => {
    const { tracker, counts } = tracked();
    tracker.prompt('peer', AT, DAY);
    calls(tracker, START_WITHIN_CALLS - 1, AT + MINUTE);
    assert.deepEqual(counts.get(DAY), { missCalls: START_WITHIN_CALLS - 1 });
    assert.deepEqual(tracker.state().block, { day: DAY, calls: START_WITHIN_CALLS - 1 });
    calls(tracker, 1, AT + START_WITHIN_CALLS * MINUTE);
    assert.deepEqual(counts.get(DAY), { missCalls: START_WITHIN_CALLS, workBlocks: 1, missNoStart: 1 });

    const short = tracked();
    short.tracker.prompt('owner', AT, DAY);
    const end = calls(short.tracker, 3, AT + MINUTE);
    short.tracker.prompt('owner', end + BLOCK_IDLE_MS, DAY);
    assert.deepEqual(short.counts.get(DAY), { missCalls: 3 });
    assert.deepEqual(short.tracker.state().block, { day: DAY, calls: 0 });
  });

  it('opens a block only for a turn asking for work after an idle hour, or as the thread begins', () => {
    const { tracker } = tracked();
    tracker.prompt('notification', AT, DAY);
    assert.equal(tracker.state().block, null);
    const last = AT + MINUTE;
    const after = calls(tracker, 1, last, 'teamrig list --session a');
    tracker.prompt('owner', last + BLOCK_IDLE_MS - MINUTE, DAY);
    assert.equal(tracker.state().block, null, 'within the hour');
    tracker.prompt('subagent', after + 3 * BLOCK_IDLE_MS, DAY);
    tracker.prompt('continuation', after + 5 * BLOCK_IDLE_MS, DAY);
    assert.equal(tracker.state().block, null, 'a subagent or a resume goes on with the work in hand');
    tracker.prompt('scheduled', after + 7 * BLOCK_IDLE_MS, DAY);
    assert.deepEqual(tracker.state().block, { day: DAY, calls: 0 });
  });

  it('takes a tool result as activity, so a turn after it is not idle', () => {
    const { tracker } = tracked();
    const after = calls(tracker, 1, AT);
    tracker.seen(after + 40 * MINUTE);
    tracker.seen(undefined);
    tracker.prompt('owner', after + 70 * MINUTE, DAY);
    assert.equal(tracker.state().block, null);
    assert.equal(tracker.state().lastAt, after + 70 * MINUTE);
  });

  it('ignores a turn with no time', () => {
    const { tracker } = tracked();
    tracker.prompt('owner', undefined, DAY);
    assert.deepEqual(tracker.state(), INITIAL_MISS_STATE);
  });

  it('counts the misses of a call on its own day, and a block on the day it began', () => {
    const { tracker, counts } = tracked();
    const late = Date.parse('2026-10-19T23:58:00Z');
    tracker.prompt('owner', late, DAY);
    calls(tracker, 1, late + MINUTE, undefined, DAY);
    calls(tracker, START_WITHIN_CALLS - 1, late + 2 * MINUTE, 'git worktree remove x', NEXT_DAY);
    assert.deepEqual(counts.get(DAY), { missCalls: 1, workBlocks: 1, missNoStart: 1 });
    assert.deepEqual(counts.get(NEXT_DAY), { missCalls: 9, worktreeRemoves: 9, missGitWorktreeRemove: 9 });
  });

  it("takes a teamrig start from a call's later tools without counting a new call", () => {
    const { tracker, counts } = tracked();
    tracker.prompt('owner', AT, DAY);
    calls(tracker, START_WITHIN_CALLS - 1, AT + MINUTE);
    tracker.callJoined([bash('teamrig start --session a')], DAY);
    assert.deepEqual(counts.get(DAY), { missCalls: START_WITHIN_CALLS - 1, workBlocks: 1 });
  });

  it('goes on from a stored state as one pass would', () => {
    const whole = tracked();
    whole.tracker.prompt('owner', AT, DAY);
    calls(whole.tracker, START_WITHIN_CALLS, AT + MINUTE);

    const first = tracked();
    first.tracker.prompt('owner', AT, DAY);
    calls(first.tracker, 4, AT + MINUTE);
    const stored = parseMissState(JSON.parse(JSON.stringify(first.tracker.state())));
    assert.ok(stored !== undefined);
    const second = tracked(stored);
    calls(second.tracker, START_WITHIN_CALLS - 4, AT + 5 * MINUTE);
    assert.deepEqual(second.counts.get(DAY), { missCalls: START_WITHIN_CALLS - 4, workBlocks: 1, missNoStart: 1 });
    assert.deepEqual(second.tracker.state(), whole.tracker.state());
  });
});

describe('parseMissState', () => {
  it('reads a stored state', () => {
    assert.deepEqual(parseMissState({ lastAt: AT, block: { day: DAY, calls: 3 } }), { lastAt: AT, block: { day: DAY, calls: 3 } });
    assert.deepEqual(parseMissState({ lastAt: 0, block: null }), INITIAL_MISS_STATE);
  });

  it('refuses a state with any damaged part', () => {
    const damaged: readonly unknown[] = [
      'state',
      { block: null },
      { lastAt: -1, block: null },
      { lastAt: 'now', block: null },
      { lastAt: Number.POSITIVE_INFINITY, block: null },
      { lastAt: AT },
      { lastAt: AT, block: 'open' },
      { lastAt: AT, block: { day: 'today', calls: 1 } },
      { lastAt: AT, block: { day: DAY, calls: 1.5 } },
      { lastAt: AT, block: { day: DAY } },
    ];
    for (const value of damaged) {
      assert.equal(parseMissState(value), undefined, JSON.stringify(value));
    }
  });
});
