import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageFindings,
  coverageRun,
  coverageTotals,
  DEFAULT_SUITE_IDLE_SECONDS,
  NO_COVERAGE_REPORT,
  parseLcov,
  parsePolicy,
  parseTapSummary,
  percent,
  POLICY_FILE,
  sourceFiles,
  strayTests,
  suiteArgs,
  suiteEnv,
  type CoveragePolicy,
  type CoverageRun,
  type FileCoverage,
  type TestSummary,
} from './coverage.ts';

const POLICY_JSON = {
  total: { lines: 90, branches: 80, functions: 90 },
  perFile: { lines: 80, branches: 70, functions: 80 },
  testSupport: ['src/testing/', 'tools/lib/fake-git.ts'],
};

function policyOf(value: unknown): CoveragePolicy {
  const parsed = parsePolicy(value);
  if (parsed.kind === 'invalid') {
    assert.fail(parsed.problem);
  }
  return parsed.policy;
}

function problemOf(value: unknown): string {
  const parsed = parsePolicy(value);
  if (parsed.kind === 'ok') {
    assert.fail('the policy was accepted');
  }
  return parsed.problem;
}

const POLICY = policyOf(POLICY_JSON);

function file(path: string, lines: number, branches = 100, functions = 100): FileCoverage {
  return { path, lines: { found: 100, hit: lines }, branches: { found: 100, hit: branches }, functions: { found: 100, hit: functions } };
}

const PASSED: TestSummary = { tests: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, notOk: [], exits: [] };

/** A run of the listed files; by default every test passed and the runner exited 0. */
function run(report: readonly FileCoverage[], listing: readonly string[], outcome: Partial<Pick<CoverageRun, 'summary' | 'status'>> = {}): CoverageRun {
  return { report, listing, summary: PASSED, status: 0, ...outcome };
}

describe('parsePolicy', () => {
  it('reads floors, test support, type-only files and exceptions', () => {
    const policy = policyOf({
      ...POLICY_JSON,
      $comment: 'notes',
      typeOnly: { 'src/types.ts': 'interfaces only' },
      exceptions: { 'src/io.ts': { lines: 60, reason: 'the OS error paths need a real disk failure' } },
    });
    assert.deepEqual(policy.total, POLICY_JSON.total);
    assert.deepEqual(policy.perFile, POLICY_JSON.perFile);
    assert.deepEqual(policy.testSupport, POLICY_JSON.testSupport);
    assert.equal(policy.typeOnly.get('src/types.ts'), 'interfaces only');
    assert.deepEqual(policy.exceptions.get('src/io.ts'), { floors: { lines: 60 }, reason: 'the OS error paths need a real disk failure' });
  });

  it('defaults the optional lists to empty and the suite idle limit to five minutes', () => {
    const policy = policyOf({ total: POLICY_JSON.total, perFile: POLICY_JSON.perFile });
    assert.deepEqual(policy.testSupport, []);
    assert.equal(policy.typeOnly.size, 0);
    assert.equal(policy.exceptions.size, 0);
    assert.equal(policy.suiteIdleSeconds, DEFAULT_SUITE_IDLE_SECONDS);
    assert.equal(DEFAULT_SUITE_IDLE_SECONDS, 300);
  });

  it('reads a suite idle limit, and refuses one that is not a whole number of seconds', () => {
    assert.equal(policyOf({ ...POLICY_JSON, suiteIdleSeconds: 30 }).suiteIdleSeconds, 30);
    assert.match(problemOf({ ...POLICY_JSON, suiteIdleSeconds: 0 }), /suiteIdleSeconds must be a whole number of seconds, 1 or more/);
    assert.match(problemOf({ ...POLICY_JSON, suiteIdleSeconds: 1.5 }), /suiteIdleSeconds must be a whole number/);
    assert.match(problemOf({ ...POLICY_JSON, suiteIdleSeconds: '300' }), /suiteIdleSeconds must be a whole number/);
  });

  it('refuses a policy that is not an object, or has an unknown key', () => {
    assert.match(problemOf([]), /must be a JSON object/);
    assert.match(problemOf({ ...POLICY_JSON, perfile: {} }), /unknown key "perfile"/);
  });

  it('refuses floors that are missing, unknown or out of range', () => {
    assert.match(problemOf({ perFile: POLICY_JSON.perFile }), /total must be an object of floors/);
    assert.match(problemOf({ ...POLICY_JSON, total: { lines: 90, branches: 80 } }), /total needs lines, branches, functions/);
    assert.match(problemOf({ ...POLICY_JSON, perFile: { ...POLICY_JSON.perFile, statements: 50 } }), /perFile\.statements is not one of/);
    assert.match(problemOf({ ...POLICY_JSON, perFile: { ...POLICY_JSON.perFile, lines: 101 } }), /perFile\.lines must be a percentage/);
    assert.match(problemOf({ ...POLICY_JSON, total: { ...POLICY_JSON.total, branches: '80' } }), /total\.branches must be a percentage/);
  });

  it('refuses a test support list that is not a list of paths', () => {
    assert.match(problemOf({ ...POLICY_JSON, testSupport: 'src/testing/' }), /testSupport must be a list/);
    assert.match(problemOf({ ...POLICY_JSON, testSupport: [''] }), /testSupport must be a list/);
  });

  it('refuses a type-only entry with no reason', () => {
    assert.match(problemOf({ ...POLICY_JSON, typeOnly: ['src/types.ts'] }), /typeOnly must be an object keyed by file path/);
    assert.match(problemOf({ ...POLICY_JSON, typeOnly: { 'src/types.ts': ' ' } }), /typeOnly\["src\/types\.ts"\] needs a reason/);
  });

  it('refuses an exception with no reason, no floor or a floor that does not lower anything', () => {
    assert.match(problemOf({ ...POLICY_JSON, exceptions: [] }), /exceptions must be an object/);
    assert.match(problemOf({ ...POLICY_JSON, exceptions: { 'src/a.ts': { lines: 50 } } }), /exceptions\["src\/a\.ts"\] needs a "reason"/);
    assert.match(problemOf({ ...POLICY_JSON, exceptions: { 'src/a.ts': 'slow' } }), /needs a "reason"/);
    assert.match(problemOf({ ...POLICY_JSON, exceptions: { 'src/a.ts': { reason: 'slow' } } }), /lowers no floor/);
    assert.match(problemOf({ ...POLICY_JSON, exceptions: { 'src/a.ts': { lines: 80, reason: 'slow' } } }), /lines must be below the per-file floor of 80/);
    assert.match(problemOf({ ...POLICY_JSON, exceptions: { 'src/a.ts': { lines: 'low', reason: 'slow' } } }), /lines must be a percentage/);
  });
});

describe('sourceFiles and strayTests', () => {
  const listing = [
    'src/a.ts',
    'src/a.test.ts',
    'src/a.spec.ts',
    'src/testing/fake.ts',
    'tools/lib/fake-git.ts',
    'tools/lib/git.ts',
    'tools/ci/coverage.json',
    'plugins/teamrig/dist/a.js',
    'docs/sample.ts',
  ];

  it('keeps the TypeScript sources under src/ and tools/, minus tests (any test name) and test support', () => {
    assert.deepEqual(sourceFiles(listing, POLICY), ['src/a.ts', 'tools/lib/git.ts']);
  });

  it('reports test files that `npm test` would never run', () => {
    const stray = strayTests(['src/a.test.ts', 'src/b.spec.ts', 'test/c.test.ts', 'tools/d.test.js', 'src/e.ts']);
    assert.deepEqual(
      stray.map((line) => line.split(':')[0]),
      ['src/b.spec.ts', 'test/c.test.ts', 'tools/d.test.js'],
    );
    assert.match(stray[0] ?? '', /name a test <name>\.test\.ts under src\/ or tools\//);
  });
});

describe('suiteArgs', () => {
  it('measures src and tools, excludes tests and test support, and writes lcov and TAP', () => {
    const args = suiteArgs(POLICY, 'out.lcov', 'out.tap');
    assert.deepEqual(args.slice(0, 2), ['--test', '--experimental-test-coverage']);
    for (const arg of [
      '--test-coverage-include=src/**',
      '--test-coverage-include=tools/**',
      '--test-coverage-exclude=**/*.test.ts',
      '--test-coverage-exclude=src/testing/**',
      '--test-coverage-exclude=tools/lib/fake-git.ts',
      '--test-reporter-destination=out.lcov',
      '--test-reporter-destination=out.tap',
    ]) {
      assert.ok(args.includes(arg), arg);
    }
    assert.deepEqual(args.slice(-2), ['tools/**/*.test.ts', 'src/**/*.test.ts']);
  });
});

describe('suiteEnv', () => {
  it('drops the parent test runner context and keeps the rest, coverage included', () => {
    assert.deepEqual(suiteEnv({ NODE_TEST_CONTEXT: 'child-v8', NODE_V8_COVERAGE: '/srv/work/cov', PATH: '/usr/bin' }), {
      NODE_V8_COVERAGE: '/srv/work/cov',
      PATH: '/usr/bin',
    });
  });
});

describe('parseLcov', () => {
  it('reads per-file totals and maps paths to repo paths', () => {
    const lcov = [
      'TN:',
      'SF:/srv/work/repo/src/a.ts',
      'FN:1,double',
      'FNF:4',
      'FNH:3',
      'DA:1,1',
      'BRF:10',
      'BRH:9',
      'LF:20',
      'LH:19',
      'end_of_record',
      'SF:/srv/work/repo/src/b.ts',
      'LF:5',
      'LH:5',
      'end_of_record',
      '',
    ].join('\r\n');
    const files = parseLcov(lcov, (absolute) => absolute.replace('/srv/work/repo/', ''));
    assert.deepEqual(files, [
      { path: 'src/a.ts', lines: { found: 20, hit: 19 }, branches: { found: 10, hit: 9 }, functions: { found: 4, hit: 3 } },
      { path: 'src/b.ts', lines: { found: 5, hit: 5 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } },
    ]);
  });

  it('ignores records with no source file', () => {
    assert.deepEqual(parseLcov('LF:3\nend_of_record\n', (path) => path), []);
  });
});

describe('parseTapSummary', () => {
  it('reads the totals the run prints last', () => {
    const tap = ['TAP version 13', '# Subtest: a', 'ok 1 - a', '1..1', '# tests 12', '# suites 2', '# pass 9', '# fail 1', '# cancelled 0', '# skipped 1', '# todo 1', '# duration_ms 40'].join('\n');
    assert.deepEqual(parseTapSummary(tap), { tests: 12, fail: 1, cancelled: 0, skipped: 1, todo: 1, notOk: [], exits: [] });
  });

  it('defaults absent counts to zero and returns nothing without a test count', () => {
    assert.deepEqual(parseTapSummary('# tests 2\n'), { tests: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, notOk: [], exits: [] });
    assert.equal(parseTapSummary('TAP version 13\n'), undefined);
  });

  it("names each `not ok` line once at any depth, CRLF or not, and leaves a todo test's out", () => {
    const tap = [
      '# Subtest: outer',
      '    # Subtest: breaks',
      '    not ok 1 - breaks',
      '    # Subtest: later',
      '    not ok 2 - later # TODO not yet',
      '    # Subtest: a \\# in its name',
      '    not ok 3 - a \\# in its name',
      'not ok 1 - outer',
      '# Subtest: thrown while built',
      'not ok 2 - thrown while built\r',
      'not ok 3 - outer',
      '# tests 3',
      '# fail 2',
    ].join('\n');
    assert.deepEqual(parseTapSummary(tap)?.notOk, ['breaks', 'a \\# in its name', 'outer', 'thrown while built']);
  });

  it('reads how each test file whose process failed with no failing test ended, and no other `not ok` entry', () => {
    // As node 22 prints them: a file killed before its first test, one that wrote to stderr and exited 4, one a signal
    // ended, and a file with a failing test of its own, which says so instead.
    const fileEntry = (index: number, name: string, fields: readonly string[]): string[] => [`# Subtest: ${name}`, `not ok ${index} - ${name}`, '  ---', ...fields.map((field) => `  ${field}`), '  ...'];
    const tap = [
      'TAP version 13',
      ...fileEntry(1, 'killed.test.mjs', ['duration_ms: 54.9368', "type: 'test'", "failureType: 'testCodeFailure'", 'exitCode: 1', 'signal: ~', "error: 'test failed'"]),
      '# boom on stderr',
      ...fileEntry(2, 'noisy.test.mjs', ['duration_ms: 57.5054', "failureType: 'testCodeFailure'", 'exitCode: 4', 'signal: ~']),
      ...fileEntry(3, 'signalled.test.mjs', ['duration_ms: 12', "failureType: 'testCodeFailure'", 'exitCode: ~', "signal: 'SIGKILL'"]),
      '# Subtest: failing.test.mjs',
      '    # Subtest: breaks',
      '    not ok 1 - breaks',
      '      ---',
      "      failureType: 'testCodeFailure'",
      '      ...',
      ...fileEntry(4, 'failing.test.mjs', ['duration_ms: 80', "failureType: 'subtestsFailed'", 'exitCode: 1', 'signal: ~']),
      '# tests 5',
      '# fail 4',
    ].join('\r\n');
    assert.deepEqual(parseTapSummary(tap)?.exits, [
      { name: 'killed.test.mjs', exitCode: 1, signal: undefined, durationMs: 54.9368 },
      { name: 'noisy.test.mjs', exitCode: 4, signal: undefined, durationMs: 57.5054 },
      { name: 'signalled.test.mjs', exitCode: undefined, signal: 'SIGKILL', durationMs: 12 },
    ]);
  });
});

describe('coverageRun', () => {
  it('reads the reports the suite wrote, with repo paths', () => {
    const lcov = ['SF:/srv/repo/src/a.ts', 'LF:4', 'LH:3', 'end_of_record', ''].join('\n');
    const run = coverageRun({ lcov, tap: '# tests 2\n', status: 0 }, ['src/a.ts'], (absolute) => absolute.replace('/srv/repo/', ''));
    assert.deepEqual(run, {
      report: [{ path: 'src/a.ts', lines: { found: 4, hit: 3 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } }],
      listing: ['src/a.ts'],
      summary: { tests: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, notOk: [], exits: [] },
      status: 0,
    });
  });

  it('counts a report the suite never wrote as no coverage and no summary, which fails the gate', () => {
    const run = coverageRun({ lcov: undefined, tap: undefined, status: null }, ['src/a.ts'], (absolute) => absolute);
    assert.deepEqual(run, { report: [], listing: ['src/a.ts'], summary: undefined, status: null });
    assert.deepEqual(coverageFindings(run, POLICY), [
      'the test run wrote no TAP summary (exit status null); it crashed or found no test files',
      NO_COVERAGE_REPORT,
    ]);
  });

  it('fails a run whose tests all passed but that reported no coverage with one line, not one per untested file', () => {
    // As Node ends a run when it cannot read a coverage file: every test passed, exit status 1, an empty lcov report.
    const run = coverageRun({ lcov: '', tap: '# tests 3\n# pass 3\n', status: 1 }, ['src/a.ts', 'src/b.ts', 'tools/c.ts'], (absolute) => absolute);
    assert.deepEqual(coverageFindings(run, POLICY), ['the test run exited with status 1 with no failing test', NO_COVERAGE_REPORT]);
  });
});

describe('percent', () => {
  it('counts a file with nothing to cover as fully covered', () => {
    assert.equal(percent({ found: 0, hit: 0 }), 100);
    assert.equal(percent({ found: 8, hit: 6 }), 75);
  });
});

describe('coverageFindings', () => {
  it('passes a clean run and prints its totals', () => {
    const passing = run([file('src/a.ts', 100), file('tools/b.ts', 90)], ['src/a.ts', 'tools/b.ts']);
    assert.deepEqual(coverageFindings(passing, POLICY), []);
    assert.equal(coverageTotals(passing, POLICY), '3 tests; 2 files: lines 95%, branches 100%, functions 100%');
  });

  it('fails a source file that no test loads', () => {
    const findings = coverageFindings(run([file('src/a.ts', 100)], ['src/a.ts', 'src/new.ts']), POLICY);
    assert.deepEqual(findings, [`src/new.ts: no test loads it; add a test that imports or runs it (a file with only types goes under typeOnly in ${POLICY_FILE})`]);
  });

  it('fails one file under the per-file floors even when the total passes', () => {
    const report = [file('src/a.ts', 100), file('src/b.ts', 100), file('src/c.ts', 100), file('src/weak.ts', 79.9, 69, 70)];
    const findings = coverageFindings(run(report, report.map((entry) => entry.path)), POLICY);
    assert.deepEqual(findings, ['src/weak.ts: lines 79.9% < 80%, branches 69% < 70%, functions 70% < 80%']);
  });

  it('fails a total under its floor even when every file passes', () => {
    const report = [file('src/a.ts', 85, 75, 85), file('src/b.ts', 85, 75, 85)];
    const findings = coverageFindings(run(report, ['src/a.ts', 'src/b.ts']), POLICY);
    assert.deepEqual(findings, ['total: lines 85% < 90%, branches 75% < 80%, functions 85% < 90%']);
  });

  it('applies an exception, and reports it once the file no longer needs it', () => {
    const policy = policyOf({ ...POLICY_JSON, total: { lines: 0, branches: 0, functions: 0 }, exceptions: { 'src/io.ts': { lines: 50, reason: 'disk failures' } } });
    assert.deepEqual(coverageFindings(run([file('src/io.ts', 60)], ['src/io.ts']), policy), []);
    assert.deepEqual(coverageFindings(run([file('src/io.ts', 40)], ['src/io.ts']), policy), ['src/io.ts: lines 40% < 50%']);
    assert.deepEqual(coverageFindings(run([file('src/io.ts', 95)], ['src/io.ts']), policy), [
      `src/io.ts: meets the per-file floors now; remove its exception from ${POLICY_FILE}`,
    ]);
  });

  it('accepts a type-only file no test loads, and reports the entry once a test loads it', () => {
    const policy = policyOf({ ...POLICY_JSON, typeOnly: { 'src/types.ts': 'interfaces only' } });
    assert.deepEqual(coverageFindings(run([file('src/a.ts', 100)], ['src/a.ts', 'src/types.ts']), policy), []);
    assert.deepEqual(coverageFindings(run([file('src/a.ts', 100), file('src/types.ts', 100)], ['src/a.ts', 'src/types.ts']), policy), [
      `src/types.ts: a test loads it, so it is not type-only; remove it from typeOnly in ${POLICY_FILE}`,
    ]);
  });

  it('reports policy entries for files that do not exist', () => {
    const policy = policyOf({ ...POLICY_JSON, typeOnly: { 'src/gone.ts': 'types' }, exceptions: { 'src/old.ts': { lines: 10, reason: 'legacy' } } });
    assert.deepEqual(coverageFindings(run([file('src/a.ts', 100)], ['src/a.ts']), policy), [
      `src/old.ts: is listed in ${POLICY_FILE} but is not a source file; remove it`,
      `src/gone.ts: is listed in ${POLICY_FILE} but is not a source file; remove it`,
    ]);
  });

  it('ignores report entries outside the source files', () => {
    const report = [file('src/a.ts', 100), file('src/testing/fake.ts', 0), file('../outside.ts', 0)];
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts', 'src/testing/fake.ts']), POLICY), []);
  });

  it('fails failing, cancelled, skipped and todo tests', () => {
    const report = [file('src/a.ts', 100)];
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { summary: { ...PASSED, fail: 2, cancelled: 1 }, status: 1 }), POLICY), ['2 failing and 1 cancelled test(s)']);
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { summary: { ...PASSED, skipped: 1, todo: 2 } }), POLICY), [
      '1 skipped and 2 todo test(s): a test that does not run cannot catch a regression; fix it or delete it',
    ]);
  });

  it('fails a run that crashed, found no tests or exited non-zero with no failing test', () => {
    const report = [file('src/a.ts', 100)];
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { summary: undefined, status: null }), POLICY), [
      'the test run wrote no TAP summary (exit status null); it crashed or found no test files',
    ]);
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { summary: { ...PASSED, tests: 0 } }), POLICY), ['the test run found no tests']);
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { status: 1 }), POLICY), ['the test run exited with status 1 with no failing test']);
  });

  it('fails a suite that failed outside any test though the run counted no failure and exited 0', () => {
    const report = [file('src/a.ts', 100)];
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { summary: { ...PASSED, notOk: ['limits', 'keys'] } }), POLICY), [
      '2 suite(s) failed outside any test, which the run counted as no failure (the error is above): limits; keys',
    ]);
    // Counted failures say so first; their suites' `not ok` lines add no second finding.
    assert.deepEqual(coverageFindings(run(report, ['src/a.ts'], { summary: { ...PASSED, fail: 1, notOk: ['breaks', 'outer'] }, status: 1 }), POLICY), [
      '1 failing and 0 cancelled test(s)',
    ]);
  });

  it('names how each test file whose process failed with no failing test ended', () => {
    const exits = [
      { name: 'src/log.test.ts', exitCode: 1, signal: undefined, durationMs: 134.2 },
      { name: 'src/noisy.test.ts', exitCode: 4, signal: undefined, durationMs: undefined },
      { name: 'src/signalled.test.ts', exitCode: undefined, signal: 'SIGKILL', durationMs: 12 },
      { name: 'src/odd.test.ts', exitCode: undefined, signal: undefined, durationMs: undefined },
    ];
    assert.deepEqual(coverageFindings(run([file('src/a.ts', 100)], ['src/a.ts'], { summary: { ...PASSED, fail: 4, exits }, status: 1 }), POLICY), [
      '4 failing and 0 cancelled test(s)',
      'src/log.test.ts: its process ended with exit code 1 and no signal after 134 ms, with no failing test to show for it; its own output, if any, is above its ✖ line, and exit code 1 with no output is how Windows shows a kill from outside',
      'src/noisy.test.ts: its process ended with exit code 4 and no signal, with no failing test to show for it; its own output, if any, is above its ✖ line',
      'src/signalled.test.ts: its process ended by signal SIGKILL after 12 ms, with no failing test to show for it; its own output, if any, is above its ✖ line',
      'src/odd.test.ts: its process ended with no exit code or signal, with no failing test to show for it; its own output, if any, is above its ✖ line',
    ]);
  });

  it('fails a test file `npm test` would never run', () => {
    const findings = coverageFindings(run([file('src/a.ts', 100)], ['src/a.ts', 'src/a.spec.ts']), POLICY);
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /^src\/a\.spec\.ts: `npm test` never runs it/);
  });

  it('prints totals without a test count when the run wrote no summary', () => {
    assert.equal(coverageTotals(run([], [], { summary: undefined }), POLICY), '0 files: lines 100%, branches 100%, functions 100%');
  });
});
