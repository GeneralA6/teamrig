import { isRecord } from '../lib/guards.ts';

/** The test files, as `npm test` runs them. */
export const TEST_FILES: readonly string[] = ['tools/**/*.test.ts', 'src/**/*.test.ts'];

/** A test file by its name, whether or not `npm test` runs it: never a source file to cover. */
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The folders whose TypeScript files must be tested. */
export const SOURCE_DIRS: readonly string[] = ['src', 'tools'];

/** Where the policy lives, for the messages that tell a contributor what to edit. */
export const POLICY_FILE = 'tools/ci/coverage.json';

export const METRICS = ['lines', 'branches', 'functions'] as const;
export type Metric = (typeof METRICS)[number];
export type Floors = Readonly<Record<Metric, number>>;

export interface Counts {
  readonly found: number;
  readonly hit: number;
}

export type Coverage = Readonly<Record<Metric, Counts>>;

export interface FileCoverage extends Coverage {
  readonly path: string;
}

/** A lower floor for one file, with the reason a reviewer accepted it. */
export interface CoverageException {
  readonly floors: Partial<Floors>;
  readonly reason: string;
}

export interface CoveragePolicy {
  readonly total: Floors;
  readonly perFile: Floors;
  /** Test doubles and helpers (a folder ends with `/`): neither measured nor required to be loaded. */
  readonly testSupport: readonly string[];
  /** Files with no runtime code, which no test can load, each with the reason. */
  readonly typeOnly: ReadonlyMap<string, string>;
  readonly exceptions: ReadonlyMap<string, CoverageException>;
  /** How long the suite may print nothing before the gate stops it as hung, in seconds. */
  readonly suiteIdleSeconds: number;
}

/**
 * The suite's silence limit when the policy sets none: the slowest test file takes seconds, so five quiet minutes mean
 * a run that will never end, which would otherwise hold the host lock to its limit (T1062).
 */
export const DEFAULT_SUITE_IDLE_SECONDS = 300;

export type PolicyResult = { readonly kind: 'ok'; readonly policy: CoveragePolicy } | { readonly kind: 'invalid'; readonly problem: string };

export interface TestSummary {
  readonly tests: number;
  readonly fail: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly todo: number;
  /** The names on the run's `not ok` lines: a failing test, the suites holding it, and a suite failed outside any test. */
  readonly notOk: readonly string[];
  /** The test files whose process ended unsuccessfully with no failing test of their own to show for it. */
  readonly exits: readonly FileExit[];
}

/** How a test file's process ended, as node's TAP reports it on the file's `not ok` line. */
export interface FileExit {
  readonly name: string;
  /** Undefined when a signal ended it. */
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  readonly durationMs: number | undefined;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(problem: string): Parsed<T> => ({ ok: false, problem });

function parseFloors(value: unknown, where: string, allowed: ReadonlySet<string>): Parsed<Partial<Floors>> {
  if (!isRecord(value)) {
    return fail(`${where} must be an object of floors`);
  }
  const floors: Partial<Record<Metric, number>> = {};
  for (const [key, floor] of Object.entries(value)) {
    const metric = METRICS.find((name) => name === key);
    if (metric === undefined) {
      if (allowed.has(key)) {
        continue;
      }
      return fail(`${where}.${key} is not one of ${METRICS.join(', ')}`);
    }
    if (typeof floor !== 'number' || floor < 0 || floor > 100) {
      return fail(`${where}.${key} must be a percentage from 0 to 100`);
    }
    floors[metric] = floor;
  }
  return ok(floors);
}

function fullFloors(value: unknown, where: string): Parsed<Floors> {
  const parsed = parseFloors(value, where, new Set());
  if (!parsed.ok) {
    return parsed;
  }
  const { lines, branches, functions } = parsed.value;
  if (lines === undefined || branches === undefined || functions === undefined) {
    return fail(`${where} needs ${METRICS.join(', ')}`);
  }
  return ok({ lines, branches, functions });
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parseException(path: string, value: unknown, perFile: Floors): Parsed<CoverageException> {
  const where = `exceptions["${path}"]`;
  const reason = isRecord(value) ? nonEmpty(value['reason']) : undefined;
  if (reason === undefined) {
    return fail(`${where} needs a "reason" a reviewer can check`);
  }
  const parsed = parseFloors(value, where, new Set(['reason']));
  if (!parsed.ok) {
    return parsed;
  }
  const floors = parsed.value;
  const set = METRICS.filter((metric) => floors[metric] !== undefined);
  if (set.length === 0) {
    return fail(`${where} lowers no floor`);
  }
  const notLower = set.find((metric) => (floors[metric] ?? 0) >= perFile[metric]);
  return notLower === undefined ? ok({ floors, reason }) : fail(`${where}.${notLower} must be below the per-file floor of ${perFile[notLower]}`);
}

function parseMap<T>(value: unknown, name: string, entry: (path: string, value: unknown) => Parsed<T>): Parsed<ReadonlyMap<string, T>> {
  if (value === undefined) {
    return ok(new Map());
  }
  if (!isRecord(value)) {
    return fail(`${name} must be an object keyed by file path`);
  }
  const map = new Map<string, T>();
  for (const [path, raw] of Object.entries(value)) {
    const parsed = entry(path, raw);
    if (!parsed.ok) {
      return parsed;
    }
    map.set(path, parsed.value);
  }
  return ok(map);
}

function parseTypeOnly(path: string, value: unknown): Parsed<string> {
  const reason = nonEmpty(value);
  return reason === undefined ? fail(`typeOnly["${path}"] needs a reason`) : ok(reason);
}

const POLICY_KEYS: ReadonlySet<string> = new Set(['$comment', 'total', 'perFile', 'testSupport', 'typeOnly', 'exceptions', 'suiteIdleSeconds']);

/** Reads the coverage policy, refusing unknown keys, so a typo never silently relaxes a floor. */
export function parsePolicy(value: unknown): PolicyResult {
  const invalid = (problem: string): PolicyResult => ({ kind: 'invalid', problem });
  if (!isRecord(value)) {
    return invalid('the coverage policy must be a JSON object');
  }
  const unknownKey = Object.keys(value).find((key) => !POLICY_KEYS.has(key));
  if (unknownKey !== undefined) {
    return invalid(`unknown key "${unknownKey}"`);
  }
  const total = fullFloors(value['total'], 'total');
  if (!total.ok) {
    return invalid(total.problem);
  }
  const perFile = fullFloors(value['perFile'], 'perFile');
  if (!perFile.ok) {
    return invalid(perFile.problem);
  }
  const testSupport = value['testSupport'] ?? [];
  if (!Array.isArray(testSupport) || !testSupport.every((entry): entry is string => nonEmpty(entry) !== undefined)) {
    return invalid('testSupport must be a list of file paths or folders ending with /');
  }
  const typeOnly = parseMap(value['typeOnly'], 'typeOnly', parseTypeOnly);
  if (!typeOnly.ok) {
    return invalid(typeOnly.problem);
  }
  const exceptions = parseMap(value['exceptions'], 'exceptions', (path, raw) => parseException(path, raw, perFile.value));
  if (!exceptions.ok) {
    return invalid(exceptions.problem);
  }
  const suiteIdleSeconds = value['suiteIdleSeconds'] ?? DEFAULT_SUITE_IDLE_SECONDS;
  if (typeof suiteIdleSeconds !== 'number' || !Number.isInteger(suiteIdleSeconds) || suiteIdleSeconds < 1) {
    return invalid('suiteIdleSeconds must be a whole number of seconds, 1 or more');
  }
  return {
    kind: 'ok',
    policy: { total: total.value, perFile: perFile.value, testSupport, typeOnly: typeOnly.value, exceptions: exceptions.value, suiteIdleSeconds },
  };
}

function isTestSupport(path: string, testSupport: readonly string[]): boolean {
  return testSupport.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

function inSourceDir(path: string): boolean {
  return SOURCE_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/** The files that must be tested, from a file listing with `/` separators. */
export function sourceFiles(listing: readonly string[], policy: CoveragePolicy): string[] {
  return listing.filter((path) => path.endsWith('.ts') && !TEST_NAME.test(path) && inSourceDir(path) && !isTestSupport(path, policy.testSupport));
}

/** Test files `npm test` never runs: a test that never runs cannot catch a regression. */
export function strayTests(listing: readonly string[]): string[] {
  return listing
    .filter((path) => TEST_NAME.test(path))
    .filter((path) => !(path.endsWith('.test.ts') && inSourceDir(path)))
    .map((path) => `${path}: \`npm test\` never runs it; name a test <name>.test.ts under ${SOURCE_DIRS.map((dir) => `${dir}/`).join(' or ')}`);
}

/** The `node --test` arguments for one coverage run, writing lcov and TAP to the given files. */
export function suiteArgs(policy: CoveragePolicy, lcovPath: string, tapPath: string): string[] {
  return [
    '--test',
    '--experimental-test-coverage',
    ...SOURCE_DIRS.map((dir) => `--test-coverage-include=${dir}/**`),
    '--test-coverage-exclude=**/*.test.ts',
    ...policy.testSupport.map((entry) => `--test-coverage-exclude=${entry.endsWith('/') ? `${entry}**` : entry}`),
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    '--test-reporter=tap',
    `--test-reporter-destination=${tapPath}`,
    ...TEST_FILES,
  ];
}

/**
 * The environment for the suite run. A run started from inside a test (the gate's own test does)
 * inherits NODE_TEST_CONTEXT, which makes `node --test` act as that runner's child and report to it.
 */
export function suiteEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
}

const LCOV_FIELDS:Readonly<Record<string, readonly [Metric, keyof Counts]>> = {
  LF: ['lines', 'found'],
  LH: ['lines', 'hit'],
  BRF: ['branches', 'found'],
  BRH: ['branches', 'hit'],
  FNF: ['functions', 'found'],
  FNH: ['functions', 'hit'],
};

type MutableCoverage = Record<Metric, { found: number; hit: number }>;

function emptyCoverage(): MutableCoverage {
  return { lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
}

/**
 * Per-file totals from an lcov report; `toRepoPath` turns its source paths into repo paths. Node writes them relative
 * to the suite's cwd (`SF:src\one.ts` on Node 22), so they mean nothing against another folder.
 */
export function parseLcov(text: string, toRepoPath: (path: string) => string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let path: string | undefined;
  let coverage = emptyCoverage();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      path = toRepoPath(line.slice(3));
      coverage = emptyCoverage();
    } else if (line === 'end_of_record' && path !== undefined) {
      files.push({ path, ...coverage });
      path = undefined;
    } else {
      const colon = line.indexOf(':');
      const field = colon < 0 ? undefined : LCOV_FIELDS[line.slice(0, colon)];
      if (field !== undefined) {
        coverage[field[0]][field[1]] = Number(line.slice(colon + 1));
      }
    }
  }
  return files;
}

/** The run's totals from TAP output: the top-level `# <name> <n>` lines, and the names its `not ok` lines carry. */
export function parseTapSummary(text: string): TestSummary | undefined {
  const counts = new Map<string, number>();
  for (const [, name, count] of text.matchAll(/^# (tests|fail|cancelled|skipped|todo) (\d+)$/gm)) {
    if (name !== undefined && count !== undefined) {
      counts.set(name, Number(count));
    }
  }
  const tests = counts.get('tests');
  return tests === undefined
    ? undefined
    : {
        tests,
        fail: counts.get('fail') ?? 0,
        cancelled: counts.get('cancelled') ?? 0,
        skipped: counts.get('skipped') ?? 0,
        todo: counts.get('todo') ?? 0,
        notOk: notOkNames(text),
        exits: fileExits(text),
      };
}

/** A YAML scalar as node's TAP writes it: `~` is none, and a quoted string loses its quotes. */
function yamlScalar(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '~' ? undefined : raw.replace(/^'(.*)'$/, '$1');
}

/**
 * The top-level `not ok` entries whose YAML block says the file's own process failed: `failureType: 'testCodeFailure'`
 * with an `exitCode` key, which node writes when a test file's process ends unsuccessfully with no failing test to
 * show for it (a file with a failing test says `subtestsFailed` instead).
 */
function fileExits(text: string): FileExit[] {
  return [...text.matchAll(/^not ok \d+ - (.*?)\r?\n {2}---\r?\n([\s\S]*?)^ {2}\.\.\.\r?$/gm)].flatMap(([, name, block]) => {
    if (name === undefined || block === undefined) {
      return [];
    }
    const fields = new Map([...block.matchAll(/^ {2}(\w+): (.*?)\r?$/gm)].flatMap(([, key, value]) => (key === undefined || value === undefined ? [] : [[key, value]])));
    if (yamlScalar(fields.get('failureType')) !== 'testCodeFailure' || !fields.has('exitCode')) {
      return [];
    }
    const exitCode = yamlScalar(fields.get('exitCode'));
    const durationMs = yamlScalar(fields.get('duration_ms'));
    return [
      {
        name,
        exitCode: exitCode === undefined ? undefined : Number(exitCode),
        signal: yamlScalar(fields.get('signal')),
        durationMs: durationMs === undefined ? undefined : Number(durationMs),
      },
    ];
  });
}

/**
 * The names on the TAP's `not ok` lines at any depth, each once, a todo test's left out (node writes its directive as
 * ` # TODO` and escapes a `#` inside a name).
 */
function notOkNames(text: string): string[] {
  const names = [...text.matchAll(/^[ \t]*not ok \d+ - (.*?)\r?$/gm)].flatMap(([, name]) => (name === undefined || / # TODO\b/.test(name) ? [] : [name]));
  return [...new Set(names)];
}

export function percent(counts: Counts): number {
  return counts.found === 0 ? 100 : (100 * counts.hit) / counts.found;
}

/** Rounded down, so a value just under a floor never prints as the floor itself. */
function shown(value: number): string {
  return `${Math.floor(value * 10) / 10}%`;
}

function totalOf(files: readonly FileCoverage[]): Coverage {
  const sum = (metric: Metric): Counts =>
    files.reduce((total, file) => ({ found: total.found + file[metric].found, hit: total.hit + file[metric].hit }), { found: 0, hit: 0 });
  return { lines: sum('lines'), branches: sum('branches'), functions: sum('functions') };
}

function gaps(coverage: Coverage, floors: Partial<Floors>): string[] {
  return METRICS.flatMap((metric) => {
    const floor = floors[metric];
    const value = percent(coverage[metric]);
    return floor !== undefined && value < floor ? [`${metric} ${shown(value)} < ${floor}%`] : [];
  });
}

function runFindings(summary: TestSummary | undefined, status: number | null): string[] {
  if (summary === undefined) {
    return [`the test run wrote no TAP summary (exit status ${String(status)}); it crashed or found no test files`];
  }
  const findings: string[] = [];
  if (summary.tests === 0) {
    findings.push('the test run found no tests');
  }
  if (summary.fail > 0 || summary.cancelled > 0) {
    findings.push(`${summary.fail} failing and ${summary.cancelled} cancelled test(s)`);
  } else if (summary.notOk.length > 0) {
    // node 22 counts a suite whose body throws before any test runs as no failure and exits 0: only its `not ok` shows it.
    findings.push(`${summary.notOk.length} suite(s) failed outside any test, which the run counted as no failure (the error is above): ${summary.notOk.join('; ')}`);
  } else if (status !== 0) {
    findings.push(`the test run exited with status ${String(status)} with no failing test`);
  }
  findings.push(...summary.exits.map(exitFinding));
  if (summary.skipped > 0 || summary.todo > 0) {
    findings.push(`${summary.skipped} skipped and ${summary.todo} todo test(s): a test that does not run cannot catch a regression; fix it or delete it`);
  }
  return findings;
}

/**
 * Names how a test file's process ended with no failing test to show for it. Its own output, if any, is above its ✖
 * line; on Windows a process killed from outside (taskkill, `process.kill`) ends with exit code 1 and writes nothing,
 * as a file did that a sweep's kill of a reused id ended (T1562).
 */
function exitFinding(exit: FileExit): string {
  const how = exit.signal !== undefined ? `by signal ${exit.signal}` : exit.exitCode !== undefined ? `with exit code ${exit.exitCode} and no signal` : 'with no exit code or signal';
  const after = exit.durationMs === undefined ? '' : ` after ${Math.round(exit.durationMs)} ms`;
  const killHint = exit.signal === undefined && exit.exitCode === 1 ? ', and exit code 1 with no output is how Windows shows a kill from outside' : '';
  return `${exit.name}: its process ended ${how}${after}, with no failing test to show for it; its own output, if any, is above its ✖ line${killHint}`;
}

export interface CoverageRun {
  readonly report: readonly FileCoverage[];
  /** Every file in the source folders, `/`-separated, as `git ls-files` lists them. */
  readonly listing: readonly string[];
  readonly summary: TestSummary | undefined;
  readonly status: number | null;
}

/** What the suite run left behind: each report's text (undefined when the run never wrote it) and the exit status. */
export interface SuiteOutput {
  readonly lcov: string | undefined;
  readonly tap: string | undefined;
  readonly status: number | null;
}

/** The run the floors judge. A report the suite never wrote counts as no coverage and no summary, which fails the gate. */
export function coverageRun(output: SuiteOutput, listing: readonly string[], toRepoPath: (path: string) => string): CoverageRun {
  return {
    report: output.lcov === undefined ? [] : parseLcov(output.lcov, toRepoPath),
    listing,
    summary: output.tap === undefined ? undefined : parseTapSummary(output.tap),
    status: output.status,
  };
}

function fileFindings(path: string, file: FileCoverage | undefined, policy: CoveragePolicy): string[] {
  if (policy.typeOnly.has(path)) {
    return file === undefined ? [] : [`${path}: a test loads it, so it is not type-only; remove it from typeOnly in ${POLICY_FILE}`];
  }
  if (file === undefined) {
    return [`${path}: no test loads it; add a test that imports or runs it (a file with only types goes under typeOnly in ${POLICY_FILE})`];
  }
  const exception = policy.exceptions.get(path);
  const missed = gaps(file, { ...policy.perFile, ...exception?.floors });
  if (missed.length > 0) {
    return [`${path}: ${missed.join(', ')}`];
  }
  return exception !== undefined && gaps(file, policy.perFile).length === 0
    ? [`${path}: meets the per-file floors now; remove its exception from ${POLICY_FILE}`]
    : [];
}

/**
 * The finding for a run that reported no coverage at all. Node writes no report when it cannot read a V8 coverage file
 * the run left ("Could not report code coverage"), such as one a child process was killed while writing as it exited.
 */
export const NO_COVERAGE_REPORT =
  'the test run reported no coverage, so no file is judged: look above for "Could not report code coverage" ' +
  '(a coverage file cut short, such as by a child process killed while it exited), fix its cause and run again';

/** Everything that fails the gate; empty when the run passes. */
export function coverageFindings(run: CoverageRun, policy: CoveragePolicy): string[] {
  const sources = sourceFiles(run.listing, policy);
  const sourceSet = new Set(sources);
  const byPath = new Map(run.report.filter((file) => sourceSet.has(file.path)).map((file) => [file.path, file]));
  const findings = [...runFindings(run.summary, run.status), ...strayTests(run.listing)];
  if (run.report.length === 0 && sources.length > 0) {
    // Every source file would read as one no test loads: one line names the cause instead.
    return [...findings, NO_COVERAGE_REPORT];
  }
  findings.push(...sources.flatMap((path) => fileFindings(path, byPath.get(path), policy)));
  for (const path of [...policy.exceptions.keys(), ...policy.typeOnly.keys()]) {
    if (!sourceSet.has(path)) {
      findings.push(`${path}: is listed in ${POLICY_FILE} but is not a source file; remove it`);
    }
  }
  const totalGaps = gaps(totalOf([...byPath.values()]), policy.total);
  if (totalGaps.length > 0) {
    findings.push(`total: ${totalGaps.join(', ')}`);
  }
  return findings;
}

/** One line for a passing run: the test count and the totals over the measured source files. */
export function coverageTotals(run: CoverageRun, policy: CoveragePolicy): string {
  const sourceSet = new Set(sourceFiles(run.listing, policy));
  const measured = run.report.filter((file) => sourceSet.has(file.path));
  const total = totalOf(measured);
  const tests = run.summary === undefined ? '' : `${run.summary.tests} tests; `;
  return `${tests}${measured.length} files: ${METRICS.map((metric) => `${metric} ${shown(percent(total[metric]))}`).join(', ')}`;
}
