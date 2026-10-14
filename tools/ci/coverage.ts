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
}

export type PolicyResult = { readonly kind: 'ok'; readonly policy: CoveragePolicy } | { readonly kind: 'invalid'; readonly problem: string };

export interface TestSummary {
  readonly tests: number;
  readonly fail: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly todo: number;
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

const POLICY_KEYS: ReadonlySet<string> = new Set(['$comment', 'total', 'perFile', 'testSupport', 'typeOnly', 'exceptions']);

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
  return { kind: 'ok', policy: { total: total.value, perFile: perFile.value, testSupport, typeOnly: typeOnly.value, exceptions: exceptions.value } };
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

/** Per-file totals from an lcov report; `toRepoPath` turns its absolute paths into repo paths. */
export function parseLcov(text: string, toRepoPath: (absolute: string) => string): FileCoverage[] {
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

/** The run's totals from TAP output: the top-level `# <name> <n>` lines. */
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
    : { tests, fail: counts.get('fail') ?? 0, cancelled: counts.get('cancelled') ?? 0, skipped: counts.get('skipped') ?? 0, todo: counts.get('todo') ?? 0 };
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
  } else if (status !== 0) {
    findings.push(`the test run exited with status ${String(status)} with no failing test`);
  }
  if (summary.skipped > 0 || summary.todo > 0) {
    findings.push(`${summary.skipped} skipped and ${summary.todo} todo test(s): a test that does not run cannot catch a regression; fix it or delete it`);
  }
  return findings;
}

export interface CoverageRun {
  readonly report: readonly FileCoverage[];
  /** Every file in the source folders, `/`-separated, as `git ls-files` lists them. */
  readonly listing: readonly string[];
  readonly summary: TestSummary | undefined;
  readonly status: number | null;
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

/** Everything that fails the gate; empty when the run passes. */
export function coverageFindings(run: CoverageRun, policy: CoveragePolicy): string[] {
  const sources = sourceFiles(run.listing, policy);
  const sourceSet = new Set(sources);
  const byPath = new Map(run.report.filter((file) => sourceSet.has(file.path)).map((file) => [file.path, file]));
  const findings = [...runFindings(run.summary, run.status), ...strayTests(run.listing)];
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
