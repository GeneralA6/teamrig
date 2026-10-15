/**
 * What test runners really print, captured from runs of the same small suite (paths moved to /work/app,
 * timings fixed), so the test-output parsers are checked against the real formats.
 */

/** node --test --test-reporter=spec: 2 of 4 failed, one nested in a suite. */
export const NODE_SPEC_FAILED = `▶ parseArgs
  ✔ splits a command (1.2ms)
  ✖ refuses a typo (1.2ms)
  ▶ help
    ✖ reads -h (1.2ms)
  ✖ help (1.2ms)
✖ parseArgs (1.2ms)
✔ top level passes (1.2ms)
ℹ tests 4
ℹ suites 2
ℹ pass 2
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12.5

✖ failing tests:

test at sample.test.mjs:5:3
✖ refuses a typo (1.2ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'add takes no --titel'
  - 'add takes no --title'
                       ^
  
      at TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:5:39)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
      at Suite.processPendingSubtests (node:internal/test_runner/test:744:18)
      at Test.postRun (node:internal/test_runner/test:1173:19)
      at Test.run (node:internal/test_runner/test:1101:12)
      at async Promise.all (index 0)
      at async Suite.run (node:internal/test_runner/test:1442:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'add takes no --titel',
    expected: 'add takes no --title',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at sample.test.mjs:7:5
✖ reads -h (1.2ms)
  Error: boom
      at TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:7:34)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
      at Test.start (node:internal/test_runner/test:944:17)
      at node:internal/test_runner/test:1440:71
      at node:internal/per_context/primordials:483:82
      at new Promise (<anonymous>)
      at new SafePromise (node:internal/per_context/primordials:451:29)
      at node:internal/per_context/primordials:483:9
      at Array.map (<anonymous>)
`;

/** node --test piped (TAP, its default when not on a terminal): the same run. */
export const NODE_TAP_FAILED = `TAP version 13
# Subtest: parseArgs
    # Subtest: splits a command
    ok 1 - splits a command
      ---
      duration_ms: 12.5
      type: 'test'
      ...
    # Subtest: refuses a typo
    not ok 2 - refuses a typo
      ---
      duration_ms: 12.5
      type: 'test'
      location: '/work/app/src/sample.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:
        + actual - expected
        
        + 'add takes no --titel'
        - 'add takes no --title'
                             ^
        
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 'add takes no --title'
      actual: 'add takes no --titel'
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:5:39)
        Test.runInAsyncScope (node:async_hooks:214:14)
        Test.run (node:internal/test_runner/test:1047:25)
        Suite.processPendingSubtests (node:internal/test_runner/test:744:18)
        Test.postRun (node:internal/test_runner/test:1173:19)
        Test.run (node:internal/test_runner/test:1101:12)
        async Promise.all (index 0)
        async Suite.run (node:internal/test_runner/test:1442:7)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
      ...
    # Subtest: help
        # Subtest: reads -h
        not ok 1 - reads -h
          ---
          duration_ms: 12.5
          type: 'test'
          location: '/work/app/src/sample.test.mjs:7:5'
          failureType: 'testCodeFailure'
          error: 'boom'
          code: 'ERR_TEST_FAILURE'
          stack: |-
            TestContext.<anonymous> (file:///work/app/src/sample.test.mjs:7:34)
            Test.runInAsyncScope (node:async_hooks:214:14)
            Test.run (node:internal/test_runner/test:1047:25)
            Test.start (node:internal/test_runner/test:944:17)
            node:internal/test_runner/test:1440:71
            node:internal/per_context/primordials:483:82
            new Promise (<anonymous>)
            new SafePromise (node:internal/per_context/primordials:451:29)
            node:internal/per_context/primordials:483:9
            Array.map (<anonymous>)
          ...
        1..1
    not ok 3 - help
      ---
      duration_ms: 12.5
      type: 'suite'
      location: '/work/app/src/sample.test.mjs:6:3'
      failureType: 'subtestsFailed'
      error: '1 subtest failed'
      code: 'ERR_TEST_FAILURE'
      ...
    1..3
not ok 1 - parseArgs
  ---
  duration_ms: 12.5
  type: 'suite'
  location: '/work/app/src/sample.test.mjs:3:1'
  failureType: 'subtestsFailed'
  error: '2 subtests failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: top level passes
ok 2 - top level passes
  ---
  duration_ms: 12.5
  type: 'test'
  ...
1..2
# tests 4
# suites 2
# pass 2
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12.5
`;

/** node --test piped: a test file that fails to load, its error printed as TAP comments. */
export const NODE_TAP_LOAD_ERROR = `TAP version 13
# node:internal/modules/esm/resolve:274
#     throw new ERR_MODULE_NOT_FOUND(
#           ^
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/app/src/missing.mjs' imported from /work/app/src/broken.test.mjs
#     at finalizeResolution (node:internal/modules/esm/resolve:274:11)
#     at moduleResolve (node:internal/modules/esm/resolve:859:10)
#     at defaultResolve (node:internal/modules/esm/resolve:983:11)
#     at \\#cachedDefaultResolve (node:internal/modules/esm/loader:717:20)
#     at ModuleLoader.resolve (node:internal/modules/esm/loader:694:38)
#     at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:308:38)
#     at ModuleJob._link (node:internal/modules/esm/module_job:183:49) {
#   code: 'ERR_MODULE_NOT_FOUND',
#   url: 'file:///work/app/src/missing.mjs'
# }
# Node.js v22.19.0
# Subtest: broken.test.mjs
not ok 1 - broken.test.mjs
  ---
  duration_ms: 12.5
  type: 'test'
  location: '/work/app/src/broken.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12.5
`;

/** Jest 30 piped: 2 of 4 failed, with a console block and coloured code frames. */
export const JEST_FAILED = `FAIL ./args.test.js
  ● Console

    console.log
      noise

      at Object.<anonymous> (args.test.js:4:34)

  ● parseArgs › refuses a typo

    expect(received).toBe(expected) // Object.is equality

    Expected: "add takes no --title"
    Received: "add takes no --titel"

    \u001b[0m \u001b[90m 1 |\u001b[39m describe(\u001b[32m'parseArgs'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m {
     \u001b[90m 2 |\u001b[39m   it(\u001b[32m'splits a command'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m1\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m
    \u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 3 |\u001b[39m   it(\u001b[32m'refuses a typo'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[32m'add takes no --titel'\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[32m'add takes no --title'\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m
     \u001b[90m   |\u001b[39m                                                               \u001b[31m\u001b[1m^\u001b[22m\u001b[39m
     \u001b[90m 4 |\u001b[39m   it(\u001b[32m'reads -h'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { console\u001b[33m.\u001b[39mlog(\u001b[32m'noise'\u001b[39m)\u001b[33m;\u001b[39m \u001b[36mthrow\u001b[39m \u001b[36mnew\u001b[39m \u001b[33mError\u001b[39m(\u001b[32m'boom'\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m
     \u001b[90m 5 |\u001b[39m })\u001b[33m;\u001b[39m
     \u001b[90m 6 |\u001b[39m\u001b[0m

      at Object.<anonymous> (args.test.js:3:63)

  ● parseArgs › reads -h

    boom

    \u001b[0m \u001b[90m 2 |\u001b[39m   it(\u001b[32m'splits a command'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m1\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m
     \u001b[90m 3 |\u001b[39m   it(\u001b[32m'refuses a typo'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[32m'add takes no --titel'\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[32m'add takes no --title'\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m
    \u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 4 |\u001b[39m   it(\u001b[32m'reads -h'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { console\u001b[33m.\u001b[39mlog(\u001b[32m'noise'\u001b[39m)\u001b[33m;\u001b[39m \u001b[36mthrow\u001b[39m \u001b[36mnew\u001b[39m \u001b[33mError\u001b[39m(\u001b[32m'boom'\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m
     \u001b[90m   |\u001b[39m                                                      \u001b[31m\u001b[1m^\u001b[22m\u001b[39m
     \u001b[90m 5 |\u001b[39m })\u001b[33m;\u001b[39m
     \u001b[90m 6 |\u001b[39m\u001b[0m

      at Object.<anonymous> (args.test.js:4:54)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 2 passed, 4 total
Snapshots:   0 total
Time:        0.645 s
Ran all test suites.
`;

/** Vitest 4 piped: 2 of 4 failed. */
export const VITEST_FAILED = `
 RUN  v4.1.11 /work/app

 ❯ args.test.mjs (3 tests | 2 failed) 8ms
     × refuses a typo 5ms
     × reads -h 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  args.test.mjs > parseArgs > refuses a typo
AssertionError: expected 'add takes no --titel' to be 'add takes no --title' // Object.is equality

Expected: "add takes no --title"
Received: "add takes no --titel"

 ❯ args.test.mjs:4:63
      2| describe('parseArgs', () => {
      3|   it('splits a command', () => { expect(1).toBe(1); });
      4|   it('refuses a typo', () => { expect('add takes no --titel').toBe('ad…
       |                                                               ^
      5|   it('reads -h', () => { throw new Error('boom'); });
      6| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  args.test.mjs > parseArgs > reads -h
Error: boom
 ❯ args.test.mjs:5:32
      3|   it('splits a command', () => { expect(1).toBe(1); });
      4|   it('refuses a typo', () => { expect('add takes no --titel').toBe('ad…
      5|   it('reads -h', () => { throw new Error('boom'); });
       |                                ^
      6| });
      7|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 2 passed (4)
   Start at  10:00:00
   Duration  313ms (transform 76ms, setup 0ms, import 146ms, tests 11ms, environment 0ms)

`;
