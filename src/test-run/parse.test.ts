import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JEST_FAILED, NODE_SPEC_FAILED, NODE_TAP_FAILED, NODE_TAP_LOAD_ERROR, VITEST_FAILED } from '../testing/test-output.ts';
import { chooseFrames, cleanOutput, parseTestOutput } from './parse.ts';

function parse(raw: string): ReturnType<typeof parseTestOutput> {
  return parseTestOutput(cleanOutput(raw));
}

describe('cleanOutput', () => {
  it('drops colour codes and terminal links, and ends lines with \\n', () => {
    const raw = '\u001b[31m✖ fails\u001b[39m\r\n\u001b]8;;file:///work/app/a.ts\u0007a.ts\u001b]8;;\u0007 \u001b(Bdone\r\n';
    assert.equal(cleanOutput(raw), '✖ fails\na.ts done\n');
  });

  it('keeps what a terminal shows of a line rewritten after a \\r', () => {
    assert.equal(cleanOutput('running 10%\rrunning 100%\nnext'), 'running 100%\nnext');
    assert.equal(cleanOutput('abcdef\rXY'), 'XYcdef');
  });
});

describe('parseTestOutput: the node:test spec reporter', () => {
  it('counts the run and takes each test from the failing tests section, with its own stack frames only', () => {
    const { runner, counts, failures } = parse(NODE_SPEC_FAILED);
    assert.deepEqual([runner, counts, failures.length], ['node', { total: 4, failed: 2 }, 2]);
    const [typo, help] = failures;
    assert.ok(typo?.startsWith("test at sample.test.mjs:5:3\n✖ refuses a typo (1.2ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"));
    assert.ok(typo?.includes("  + 'add takes no --titel'\n  - 'add takes no --title'"));
    assert.ok(typo?.endsWith('      at TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:5:39)'), 'Node and the error object after the frames are left out');
    assert.equal(
      help,
      ['test at sample.test.mjs:7:5', '✖ reads -h (1.2ms)', '  Error: boom', '      at TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:7:34)'].join('\n'),
    );
  });

  it('reads failures printed under their test when there is no failing tests section, and counts cancelled tests as failed', () => {
    const output = [
      '▶ parseArgs',
      '  ✔ splits a command (0.5ms)',
      '  ✖ refuses a typo (1.5ms)',
      "    AssertionError [ERR_ASSERTION]: 'a' !== 'b'",
      '        at TestContext.<anonymous> (file:///work/app/src/args.test.ts:5:39)',
      '        at Test.runInAsyncScope (node:async_hooks:214:14)',
      '  ✖ times out (1.5ms)',
      '▶ parseArgs (3ms)',
      'ℹ tests 3',
      'ℹ pass 1',
      'ℹ fail 1',
      'ℹ cancelled 1',
    ].join('\n');
    assert.deepEqual(parse(output), {
      runner: 'node',
      counts: { total: 3, failed: 2 },
      failures: ["✖ refuses a typo (1.5ms)\n  AssertionError [ERR_ASSERTION]: 'a' !== 'b'\n      at TestContext.<anonymous> (file:///work/app/src/args.test.ts:5:39)"],
    });
  });
});

describe('parseTestOutput: TAP', () => {
  it("names each failed test by its suites, keeps its YAML without timings, and leaves out the suites it failed", () => {
    const { runner, counts, failures } = parse(NODE_TAP_FAILED);
    assert.deepEqual([runner, counts], ['tap', { total: 4, failed: 2 }]);
    assert.equal(failures.length, 2);
    assert.ok(failures[0]?.startsWith("not ok parseArgs > refuses a typo\n  location: '/work/app/src/sample.test.mjs:5:3'\n  error: |-\n    Expected values"));
    assert.equal(
      failures[1],
      [
        'not ok parseArgs > help > reads -h',
        "  location: '/work/app/src/sample.test.mjs:7:5'",
        "  error: 'boom'",
        "  code: 'ERR_TEST_FAILURE'",
        '  stack: |-',
        '    TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:7:34)',
      ].join('\n'),
    );
  });

  it('keeps the error a test file printed before it failed to load', () => {
    const { counts, failures } = parse(NODE_TAP_LOAD_ERROR);
    assert.deepEqual(counts, { total: 1, failed: 1 });
    const [block = ''] = failures;
    assert.ok(block.startsWith('not ok broken.test.mjs\n  node:internal/modules/esm/resolve:274'));
    assert.ok(block.includes("  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/app/src/missing.mjs' imported from /work/app/src/broken.test.mjs"));
    assert.ok(!block.includes("url: 'file:///work/app/src/missing.mjs'"), "the error's properties after its frames are left out");
    assert.ok(block.endsWith("  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'"));
  });

  it('reads plain TAP, where TODO and SKIP points are not failures', () => {
    const output = [
      'TAP version 13',
      '# add',
      'ok 1 should be equal',
      'not ok 2 should be truthy',
      '  ---',
      '    operator: ok',
      '    expected: true',
      '    actual:   false',
      '  ...',
      'not ok 3 later # TODO not yet',
      'ok 4 skipped # SKIP',
      'not ok 5',
      '',
      '1..5',
      '# tests 5',
      '# pass  2',
      '# fail  2',
    ].join('\n');
    assert.deepEqual(parse(output), {
      runner: 'tap',
      counts: { total: 5, failed: 2 },
      failures: ['not ok should be truthy\n  operator: ok\n  expected: true\n  actual:   false', 'not ok'],
    });
  });

  it('has no counts without a summary', () => {
    assert.deepEqual(parse('not ok 1 - fails'), { runner: 'tap', counts: null, failures: ['not ok fails'] });
  });
});

describe('parseTestOutput: Jest', () => {
  it('counts the Tests line and takes each ● block, colour codes stripped and console blocks left out', () => {
    const { runner, counts, failures } = parse(JEST_FAILED);
    assert.deepEqual([runner, counts, failures.length], ['jest', { total: 4, failed: 2 }, 2]);
    assert.ok(failures[0]?.startsWith('● parseArgs › refuses a typo\n\n  expect(received).toBe(expected) // Object.is equality'));
    assert.ok(failures[0]?.includes("  > 3 |   it('refuses a typo'"));
    assert.ok(failures[1]?.startsWith('● parseArgs › reads -h\n\n  boom'));
    assert.ok(failures[1]?.endsWith('    at Object.<anonymous> (args.test.js:4:54)'));
    assert.ok(failures.every((block) => !block.includes('\u001b') && !block.includes('Console')));
  });

  it('prints a test repeated in the summary of failing tests once, and sums the Tests lines of several projects', () => {
    const block = ['  ● api › saves', '', '    expected 1', '', '      at Object.<anonymous> (api.test.js:3:5)'];
    const output = ['FAIL api/api.test.js', ...block, '', 'Summary of all failing tests', 'FAIL api/api.test.js', ...block, '', 'Tests:       1 failed, 9 passed, 10 total', 'Tests:       5 passed, 5 total'].join('\n');
    assert.deepEqual(parse(output), {
      runner: 'jest',
      counts: { total: 15, failed: 1 },
      failures: ['● api › saves\n\n  expected 1\n\n    at Object.<anonymous> (api.test.js:3:5)'],
    });
  });

  it('has no counts when only the Test Suites line is there', () => {
    assert.deepEqual(parse('Test Suites: 1 failed, 1 total'), { runner: 'jest', counts: null, failures: [] });
  });
});

describe('parseTestOutput: Vitest', () => {
  it('counts the Tests line and takes each FAIL block up to its rule', () => {
    const { runner, counts, failures } = parse(VITEST_FAILED);
    assert.deepEqual([runner, counts, failures.length], ['vitest', { total: 4, failed: 2 }, 2]);
    assert.ok(failures[0]?.startsWith("FAIL  args.test.mjs > parseArgs > refuses a typo\nAssertionError: expected 'add takes no --titel' to be 'add takes no --title'"));
    assert.ok(failures[1]?.startsWith('FAIL  args.test.mjs > parseArgs > reads -h\nError: boom\n ❯ args.test.mjs:5:32'));
    assert.ok(failures[1]?.endsWith('      7|'), 'the block ends before the rule under it');
  });

  it('falls back on the × lines of the progress list when no FAIL block is printed', () => {
    const output = [' ❯ src/a.test.ts (2 tests | 1 failed) 8ms', '     × adds 5ms', '', ' Test Files  1 failed (1)', '      Tests  1 failed | 1 passed (2)'].join('\n');
    assert.deepEqual(parse(output), { runner: 'vitest', counts: { total: 2, failed: 1 }, failures: ['× adds 5ms'] });
  });

  it('has no counts when no test ran', () => {
    assert.deepEqual(parse(' Test Files  1 failed (1)\n      Tests  no tests'), { runner: 'vitest', counts: null, failures: [] });
  });
});

describe('parseTestOutput: other output', () => {
  it('reads output from no known runner as unknown, with no counts or failures', () => {
    assert.deepEqual(parse('src/a.ts(3,1): error TS2304: Cannot find name "x".\n'), { runner: 'unknown', counts: null, failures: [] });
  });
});

describe('chooseFrames', () => {
  it("takes the test's own frames before Node's and dependencies', at most three", () => {
    const frames = [
      'at Test.run (node:internal/test_runner/test:1047:25)',
      'at a (file:///work/app/a.ts:1:1)',
      'at expect (/work/app/node_modules/expect/build/index.js:9:9)',
      'at b (file:///work/app/b.ts:2:2)',
      'at new Promise (<anonymous>)',
      'at c (file:///work/app/c.ts:3:3)',
      'at d (file:///work/app/d.ts:4:4)',
    ];
    assert.deepEqual(chooseFrames(frames), ['at a (file:///work/app/a.ts:1:1)', 'at b (file:///work/app/b.ts:2:2)', 'at c (file:///work/app/c.ts:3:3)']);
  });

  it('keeps the first frames when every frame is internal', () => {
    const internal = ['at w (node:a:1:1)', 'at x (node:b:1:1)', 'at async Promise.all (index 0)', 'at z (node:d:1:1)'];
    assert.deepEqual(chooseFrames(internal), internal.slice(0, 3));
  });
});
