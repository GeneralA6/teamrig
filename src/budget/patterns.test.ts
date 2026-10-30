import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolResult, ToolUse } from './line.ts';
import { contextTokens, WEIGHTS, type Usage } from './weights.ts';
import {
  emptyPatterns,
  INITIAL_PATTERN_STATE,
  kindOf,
  BURN_FIELDS,
  parsePatternCounts,
  parsePatternState,
  PATTERN_FIELDS,
  PatternTracker,
  testFailed,
  type Count,
  type PatternField,
  type ToolKind,
} from './patterns.ts';

describe('kindOf', () => {
  const cases: readonly (readonly [string, string | undefined, ToolKind])[] = [
    ['Edit', undefined, 'edit'],
    ['Write', undefined, 'edit'],
    ['NotebookEdit', undefined, 'edit'],
    ['Read', undefined, 'read'],
    ['Grep', undefined, 'read'],
    ['Glob', undefined, 'read'],
    ['WebFetch', undefined, 'other'],
    ['Bash', undefined, 'other'],
    ['Bash', "cat > src/a.ts <<'EOF'", 'edit'],
    ['Bash', "cat <<'EOF' > src/a.ts", 'edit'],
    ['Bash', 'sed -i s/a/b/ src/a.ts', 'edit'],
    ['Bash', "node -e \"require('fs').writeFileSync('a', 'b')\"", 'edit'],
    ['PowerShell', 'Set-Content -Path a.txt -Value b', 'edit'],
    ['Bash', 'git apply fix.patch', 'edit'],
    ['Bash', "cat > a.ts <<'EOF'\nx\nEOF\nnpm test", 'editTest'],
    ['Bash', 'npm test', 'testFull'],
    ['Bash', 'npm run test:cli', 'testFull'],
    ['Bash', 'npx vitest run', 'testFull'],
    ['Bash', 'node --test "src/**/*.test.ts"', 'testFull'],
    ['Bash', 'node --disable-warning=ExperimentalWarning --test src/budget/meter.test.ts', 'testTargeted'],
    ['Bash', 'npx jest src/budget/meter.spec.ts', 'testTargeted'],
    ['Bash', 'npm test -- src/budget/meter.spec.ts', 'testTargeted'],
    ['Bash', 'npm run typecheck', 'build'],
    ['Bash', 'tsc -p tsconfig.json', 'build'],
    ['Bash', 'teamrig list --session lead', 'teamrigCli'],
    ['Bash', 'node dist/cli/main.js show T1', 'teamrigCli'],
    ['Bash', 'git status --short', 'git'],
    ['Bash', 'cd /repo && git log -3', 'git'],
    ['Bash', 'cat src/a.ts', 'read'],
    ['Bash', 'grep -n x src/a.ts', 'read'],
    ['Bash', 'echo hi', 'other'],
    ['Bash', "node - <<'EOF'\nrequire('fs').writeFileSync('a', 'b')\nEOF", 'edit'],
    ['Bash', 'teamrig heavy --session a --what t -- teamrig test --session a -- node --test src/a.test.ts', 'testTargeted'],
    ['Bash', 'teamrig heavy --what t -- npm run build:dist', 'build'],
    ['Bash', 'node node_modules/typescript/bin/tsc -p tsconfig.json', 'build'],
    ['Bash', 'teamrig.cmd doctor', 'teamrigCli'],
    ['Bash', 'cd /repo; git status', 'git'],
    ['Bash', 'ls src | grep x', 'read'],
    ['PowerShell', 'Get-Content a.log | Select-String x', 'other'],
  ];
  for (const [name, command, kind] of cases) {
    it(`reads ${name} ${command ?? ''} as ${kind}`, () => {
      assert.equal(kindOf({ name, command }), kind);
    });
  }

  // T551: words inside an argument, a note or a heredoc's body run nothing.
  const quoted: readonly (readonly [string, ToolKind])[] = [
    ['teamrig add --description "npm ci, jest and build"', 'teamrigCli'],
    ['teamrig set T1 --status done --note "ran npm test and tsc, then git apply fix.patch"', 'teamrigCli'],
    ['git commit -m "sed -i the specs, then node --test src/a.test.ts"', 'git'],
    ['echo "npm test && tsc" | grep test', 'other'],
    ["cat > notes.md <<'EOF'\nnpm test, then npm run build\nEOF", 'edit'],
    ['grep -rn "writeFileSync" src', 'read'],
  ];
  for (const [command, kind] of quoted) {
    it(`reads ${command} as ${kind}, by the programs it runs`, () => {
      assert.equal(kindOf({ name: 'Bash', command }), kind);
    });
  }
});

describe('testFailed', () => {
  it('reads an error mark and the common failure summaries as a failure', () => {
    assert.equal(testFailed({ isError: true, text: '' }), true);
    for (const text of ['ℹ tests 5\nℹ fail 2', '# fail 1', 'x ✖ y', 'not ok 3 - case', 'Tests: 2 failed, 9 passed', 'FAIL src/a.test.ts']) {
      assert.equal(testFailed({ isError: false, text }), true, text);
    }
  });

  it('reads a clean run as a pass', () => {
    assert.equal(testFailed({ isError: false, text: 'ℹ pass 5\nℹ fail 0\nok 1 - case' }), false);
  });
});

/** Collects counts the way the meter's tally does. */
function recorder(): { count: Count; counts: Record<PatternField, number> } {
  const counts = emptyPatterns();
  return {
    count: (field, amount) => {
      counts[field] += amount;
    },
    counts,
  };
}

function bash(id: string, command: string): ToolUse {
  return { id, name: 'Bash', command };
}

function tool(id: string, name: string): ToolUse {
  return { id, name, command: undefined };
}

function result(id: string, text: string, isError = false): ToolResult {
  return { id, isError, text };
}

/** A call that reads its whole context from the cache. */
function warm(context: number): Usage {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: context, output: 0 };
}

/** One call: it starts and is charged a fixed W, its results arrive, and it is closed. */
function call(tracker: PatternTracker, count: Count, context: number, tools: readonly ToolUse[], results: readonly ToolResult[] = []): void {
  tracker.callStarted(warm(context), tools, count);
  tracker.charged(10, count);
  tracker.results(results, count);
  tracker.callClosed(context, 10, count);
}

const PASS = 'ℹ pass 3\nℹ fail 0';
const FAIL = 'ℹ pass 2\nℹ fail 1';

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
}

describe('PatternTracker', () => {
  it('counts a lookup that follows a lookup in the same turn, never across turns', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    tracker.prompt('owner', count);
    call(tracker, count, 1_000, [tool('a', 'Read')]);
    call(tracker, count, 1_000, [bash('b', 'git status')]);
    call(tracker, count, 1_000, [tool('c', 'Grep'), tool('d', 'Read')]);
    call(tracker, count, 1_000, [tool('e', 'Read')]);
    tracker.prompt('owner', count);
    call(tracker, count, 1_000, [tool('f', 'Read')]);
    assert.equal(counts.readChain, 1);
    assert.equal(counts.readChainW, 10);
  });

  it('counts single edits in a row and prices each at a re-read of its context', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    call(tracker, count, 1_000, [tool('a', 'Edit')]);
    call(tracker, count, 2_000, [tool('b', 'Write')]);
    call(tracker, count, 3_000, [tool('c', 'Edit'), tool('d', 'Edit')]);
    assert.equal(counts.editChain, 1);
    assert.equal(counts.editChainSavedW, 200);
  });

  it('counts a test run right after a single edit, and a call that did both', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    call(tracker, count, 1_000, [tool('a', 'Edit')]);
    call(tracker, count, 4_000, [bash('b', 'npm test')], [result('b', PASS)]);
    call(tracker, count, 1_000, [tool('c', 'Edit'), bash('d', 'npm test')]);
    call(tracker, count, 1_000, [bash('e', "cat > a.ts <<'EOF'\nx\nEOF\nnpm test")]);
    assert.equal(counts.editThenTest, 1);
    assert.equal(counts.editThenTestSavedW, 400);
    assert.equal(counts.editTestJoined, 2);
  });

  it('sorts a re-run with no edit by how the run before it ended', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    call(tracker, count, 1_000, [bash('a', 'npm test 2>&1 | tail -5')], [result('a', FAIL)]);
    call(tracker, count, 1_000, [bash('b', 'npm test')], [result('b', 'boom', true)]);
    call(tracker, count, 1_000, [bash('c', 'npm test')], [result('c', PASS)]);
    call(tracker, count, 1_000, [bash('d', 'npm test')]);
    call(tracker, count, 1_000, [bash('e', 'npm test')]);
    assert.equal(counts.rerunFailedPiped, 1);
    assert.equal(counts.rerunFailedPipedW, 10);
    assert.equal(counts.rerunFailedFull, 1);
    assert.equal(counts.rerunAfterPass, 1);
    assert.equal(counts.rerunAfterPassW, 10);
  });

  it('counts no re-run after an edit or in a new turn', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    call(tracker, count, 1_000, [bash('a', 'npm test')], [result('a', FAIL)]);
    call(tracker, count, 1_000, [tool('b', 'Edit')]);
    call(tracker, count, 1_000, [bash('c', 'npm test')], [result('c', FAIL)]);
    tracker.prompt('owner', count);
    call(tracker, count, 1_000, [bash('d', 'npm test')], [result('d', PASS)]);
    assert.equal(counts.rerunFailedFull + counts.rerunFailedPiped + counts.rerunAfterPass, 0);
  });

  it('charges passing test output a cache write, then a re-read per later call until a compaction', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    const text = 'x'.repeat(2_280);
    call(tracker, count, 100_000, [bash('a', 'node --test src/a.test.ts')], [result('a', text), result('zz', text)]);
    assert.equal(counts.passRuns, 1);
    near(counts.passTokens, 1_000);
    near(counts.passRentW, 2_000);
    call(tracker, count, 90_000, [tool('b', 'Read')]);
    call(tracker, count, 95_000, [tool('c', 'Read')]);
    near(counts.passRentW, 2_200);
    call(tracker, count, 40_000, [tool('d', 'Read')]);
    call(tracker, count, 50_000, [tool('e', 'Read')]);
    near(counts.passRentW, 2_200);
    assert.equal(tracker.state().rentTokens, 0);
  });

  it('settles a result that arrives after its call closed, and ignores results of other tools', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    tracker.callStarted(warm(1_000), [bash('a', 'npm test'), tool('b', 'Read')], count);
    tracker.callJoined([tool('c', 'Grep')]);
    tracker.callClosed(1_000, 10, count);
    tracker.results([result('b', 'text'), result('a', FAIL)], count);
    assert.equal(tracker.state().turnTest?.failed, true);
    call(tracker, count, 1_000, [bash('d', 'npm test')]);
    assert.equal(counts.rerunFailedFull, 1);
    assert.equal(counts.passRuns, 0);
  });

  it('counts each turn and its W under what started it, a resumed turn under the turn it compacted', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    tracker.prompt('owner', count);
    call(tracker, count, 1_000, [tool('a', 'Read')]);
    tracker.prompt('continuation', count);
    call(tracker, count, 1_000, [tool('b', 'Read')]);
    tracker.prompt('peer', count);
    call(tracker, count, 1_000, [tool('c', 'Read')]);
    call(tracker, count, 1_000, [tool('d', 'Edit')]);
    tracker.prompt('notification', count);
    const seen = [counts.ownerTurns, counts.ownerW, counts.peerTurns, counts.peerW, counts.notificationTurns, counts.notificationW];
    assert.deepEqual(seen, [1, 20, 1, 20, 1, 0]);
  });

  it('counts a call that re-wrote most of its context to the cache as cold, with the W of those writes', () => {
    const { count, counts } = recorder();
    const tracker = new PatternTracker(INITIAL_PATTERN_STATE);
    tracker.prompt('owner', count);
    const usage = (written: number, read: number): Usage => ({ ...warm(read), cacheWrite1h: written });
    for (const [index, each] of [usage(30_000, 10_000), usage(5_000, 1_000), usage(25_000, 75_000)].entries()) {
      tracker.callStarted(each, [tool(`t${index}`, 'Read')], count);
      tracker.callClosed(contextTokens(each), 10, count);
    }
    assert.equal(counts.coldCalls, 1);
    near(counts.coldW, 30_000 * WEIGHTS.cacheWrite1h);
  });

  it('multiplies the W it works out by its weight, and keeps the W the meter charged as given', () => {
    const counted = (weight: number): Record<PatternField, number> => {
      const { count, counts } = recorder();
      const tracker = new PatternTracker(INITIAL_PATTERN_STATE, weight);
      const cold: Usage = { ...warm(10_000), cacheWrite1h: 30_000 };
      tracker.callStarted(cold, [tool('a', 'Read')], count);
      tracker.charged(10, count);
      tracker.callClosed(contextTokens(cold), 10, count);
      call(tracker, count, 1_000, [tool('b', 'Read')]);
      call(tracker, count, 1_000, [tool('c', 'Edit')]);
      call(tracker, count, 1_000, [tool('d', 'Edit')]);
      call(tracker, count, 4_000, [bash('e', 'npm test')], [result('e', PASS)]);
      call(tracker, count, 4_000, [bash('f', 'npm test')]);
      return counts;
    };
    const once = counted(1);
    const weighed = counted(2.5);
    const worked: readonly PatternField[] = ['coldW', 'passRentW', 'editChainSavedW', 'editThenTestSavedW'];
    assert.ok(worked.every((field) => once[field] > 0) && once.readChainW > 0 && once.rerunAfterPassW > 0);
    for (const field of PATTERN_FIELDS) {
      near(weighed[field], worked.includes(field) ? 2.5 * once[field] : once[field]);
    }
  });

  it('resumes from a stored state exactly where it stopped', () => {
    const { count, counts } = recorder();
    const first = new PatternTracker(INITIAL_PATTERN_STATE);
    first.prompt('owner', count);
    first.callStarted(warm(1_000), [tool('a', 'Edit')], count);
    const stored = parsePatternState(JSON.parse(JSON.stringify(first.state())));
    assert.deepEqual(stored, first.state());
    const resumed = new PatternTracker(stored ?? INITIAL_PATTERN_STATE);
    resumed.callClosed(1_000, 10, count);
    call(resumed, count, 1_000, [tool('b', 'Edit')]);
    assert.equal(counts.editChain, 1);
  });
});

describe('parsePatternState', () => {
  /** A state as 0.33.0 stored it, before the turn's trigger. */
  const before034 = {
    turn: 2,
    prev: { turn: 2, single: 'edit' },
    open: [{ id: 'a', kind: 'testFull', piped: false, failed: null }],
    turnTest: { id: 'b', kind: 'testTargeted', piped: true, failed: true },
    rentTokens: 12.5,
    lastContext: 900,
  };
  const valid = { ...before034, trigger: 'peer' };

  it('reads a stored state, empty parts included', () => {
    assert.deepEqual(parsePatternState(valid), valid);
    assert.deepEqual(parsePatternState({ ...valid, prev: { turn: 1, single: null }, open: null, turnTest: null }), {
      ...valid,
      prev: { turn: 1, single: null },
      open: null,
      turnTest: null,
    });
    assert.deepEqual(parsePatternState(INITIAL_PATTERN_STATE), INITIAL_PATTERN_STATE);
    assert.deepEqual(parsePatternState(before034), { ...before034, trigger: 'other' });
  });

  it('refuses a state with any damaged part', () => {
    const damaged: readonly unknown[] = [
      'state',
      { ...valid, turn: -1 },
      { ...valid, rentTokens: Number.NaN },
      { ...valid, lastContext: 'big' },
      { ...valid, trigger: 'boss' },
      { ...valid, prev: 'x' },
      { ...valid, prev: { turn: 1.5, single: null } },
      { ...valid, prev: { turn: 1, single: 'fly' } },
      { ...valid, open: 'tools' },
      { ...valid, open: [{ id: 'a', kind: 'fly', piped: false, failed: null }] },
      { ...valid, open: ['a'] },
      { ...valid, turnTest: { id: 'b', kind: 'testFull', piped: 'no', failed: null } },
      { ...valid, turnTest: { id: 'b', kind: 'testFull', piped: false, failed: 'maybe' } },
      { ...valid, turnTest: { kind: 'testFull', piped: false, failed: null } },
    ];
    for (const value of damaged) {
      assert.equal(parsePatternState(value), undefined, JSON.stringify(value));
    }
  });
});

describe('parsePatternCounts and emptyPatterns', () => {
  it('reads every counter, and refuses a missing or damaged one', () => {
    const counts = { ...emptyPatterns(), readChain: 3, passRentW: 1.5 };
    assert.deepEqual(parsePatternCounts(counts), counts);
    assert.equal(parsePatternCounts('counts'), undefined);
    assert.equal(parsePatternCounts({ ...counts, editChain: -1 }), undefined);
    assert.equal(parsePatternCounts({ ...counts, coldW: -1 }), undefined);
    const isBurn = (field: string): boolean => BURN_FIELDS.some((each) => each === field);
    const before034 = Object.fromEntries(Object.entries(counts).filter(([field]) => !isBurn(field)));
    assert.deepEqual(parsePatternCounts(before034), { ...counts, ...Object.fromEntries(BURN_FIELDS.map((field) => [field, 0])) });
    assert.equal(parsePatternCounts(Object.fromEntries(Object.entries(counts).filter(([field]) => field !== 'readChain'))), undefined);
    const { readChain, ...missing } = counts;
    assert.equal(readChain, 3);
    assert.equal(parsePatternCounts(missing), undefined);
  });

  it('gives a fresh copy each time', () => {
    const counts = emptyPatterns();
    counts.readChain = 4;
    assert.equal(emptyPatterns().readChain, 0);
  });
});
