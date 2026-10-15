/**
 * Reads what a test run printed: which runner it was, how many tests ran and failed, and each failing
 * test's own lines (name, error, first stack frames). Pure, so each runner's real output is a test fixture.
 */

export type TestRunner = 'node' | 'tap' | 'jest' | 'vitest' | 'unknown';

export interface TestCounts {
  readonly total: number;
  readonly failed: number;
}

export interface TestOutput {
  readonly runner: TestRunner;
  /** Summed over every summary in the output; null when it has none. */
  readonly counts: TestCounts | null;
  /** Each failing test as printed, in order, its stack cut to its first frames. */
  readonly failures: readonly string[];
}

interface RunnerReader {
  readonly runner: Exclude<TestRunner, 'unknown'>;
  detects(lines: readonly string[]): boolean;
  counts(lines: readonly string[]): TestCounts | null;
  failures(lines: readonly string[]): string[][];
}

/** Colour and cursor codes: CSI sequences, OSC sequences (links, titles), character set choices and two-byte escapes. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()*+][0-9A-Za-z]|\u001b[@-Z\\-_]/g;
const MAX_FRAMES = 3;
const FRAME = /^\s*(?:at |❯ )\S/;
const INTERNAL_FRAME = /\bnode:|node_modules|\((?:<anonymous>|index \d+)\)$/;

/** The text a terminal would show: no colour codes, `\n` line ends, and a `\r` rewrite of a line kept as its result. */
export function cleanOutput(raw: string): string {
  return raw.replace(ANSI, '').replaceAll('\r\n', '\n').split('\n').map(overprint).join('\n');
}

function overprint(line: string): string {
  return line.split('\r').reduce((shown, part) => part + shown.slice(part.length));
}

/** The runner, counts and failing tests in a run's cleaned output; `unknown` with none when no runner is recognised. */
export function parseTestOutput(output: string): TestOutput {
  const lines = output.split('\n');
  const reader = READERS.find((candidate) => candidate.detects(lines));
  if (reader === undefined) {
    return { runner: 'unknown', counts: null, failures: [] };
  }
  const failures = reader.failures(lines).map(tidyBlock).filter((block) => block !== '');
  return { runner: reader.runner, counts: reader.counts(lines), failures: [...new Set(failures)] };
}

/** The first stack frames of a run of them, skipping Node's own and dependencies' frames when the test's own are there. */
export function chooseFrames(run: readonly string[]): string[] {
  const own = run.filter((frame) => !INTERNAL_FRAME.test(frame));
  return (own.length > 0 ? own : run).slice(0, MAX_FRAMES);
}

/** The keys a summary line pattern names, each summed over every line it matches. */
function sums(lines: readonly string[], pattern: RegExp): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const [, key, value] = pattern.exec(line) ?? [];
    if (key !== undefined && value !== undefined) {
      totals.set(key, (totals.get(key) ?? 0) + Number(value));
    }
  }
  return totals;
}

/** Node's counts: failed takes in the cancelled tests, which are failures too. */
function nodeCounts(totals: ReadonlyMap<string, number>): TestCounts | null {
  const total = totals.get('tests');
  return total === undefined ? null : { total, failed: (totals.get('fail') ?? 0) + (totals.get('cancelled') ?? 0) };
}

/** Counts from `Tests` lines, each read by `pattern` as (failed-and-passed text, total). */
function lineCounts(lines: readonly string[], pattern: RegExp): TestCounts | null {
  const found = lines.flatMap((line): TestCounts[] => {
    const [, parts, total] = pattern.exec(line) ?? [];
    return parts === undefined || total === undefined ? [] : [{ total: Number(total), failed: Number(/(\d+) failed/.exec(parts)?.[1] ?? 0) }];
  });
  return found.length === 0 ? null : found.reduce((sum, next) => ({ total: sum.total + next.total, failed: sum.failed + next.failed }));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The first line at or after `start` that passes `test`, or -1. */
function indexFrom(lines: readonly string[], start: number, test: (line: string) => boolean): number {
  for (let at = start; at < lines.length; at += 1) {
    if (test(lines[at] ?? '')) {
      return at;
    }
  }
  return -1;
}

/** Lines at or after `start` up to the first that passes `test`, or to the end. */
function upTo(lines: readonly string[], start: number, test: (line: string) => boolean): number {
  const end = indexFrom(lines, start, test);
  return end === -1 ? lines.length : end;
}

function isBody(line: string): boolean {
  return line.trim() === '' || indentOf(line) > 0;
}

/** Marked lines (at any depth) with the deeper lines under them; a marked line with nothing under it is a suite. */
function bodiedBlocks(lines: readonly string[], marker: RegExp): string[][] {
  const blocks: string[][] = [];
  lines.forEach((line, index) => {
    if (!marker.test(line)) {
      return;
    }
    const depth = indentOf(line);
    const body = lines.slice(index + 1, upTo(lines, index + 1, (next) => next.trim() !== '' && indentOf(next) <= depth));
    if (body.some((next) => next.trim() !== '')) {
      blocks.push([line, ...body]);
    }
  });
  return blocks;
}

/** Node's `✖ failing tests:` section: a `test at <file>` line, the `✖ <name>` line, then the indented error. */
function nodeSection(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const afterLocation = current?.length === 1 && (current[0] ?? '').startsWith('test at ') && line.startsWith('✖ ');
    if (current !== null && (isBody(line) || afterLocation)) {
      current.push(line);
    } else if (line.startsWith('test at ') || line.startsWith('✖ ')) {
      current = [line];
      blocks.push(current);
    } else {
      current = null;
    }
  }
  return blocks;
}

const NODE_SPEC: RunnerReader = {
  runner: 'node',
  detects: (lines) => lines.some((line) => /^ℹ tests \d+$/.test(line)),
  counts: (lines) => nodeCounts(sums(lines, /^ℹ (tests|fail|cancelled)\s+(\d+)$/)),
  failures: (lines) => {
    const section = lines.indexOf('✖ failing tests:');
    return section === -1 ? bodiedBlocks(lines, /^\s*✖ /) : nodeSection(lines.slice(section + 1));
  },
};

const TAP_POINT = /^(\s*)(not )?ok \d+(?: - | |$)(.*?)(\s+# (?:TODO|SKIP)\b.*)?$/i;
const TAP_SUBTEST = /^(\s*)# Subtest: (.*)$/;
const TAP_SUMMARY = /^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s/;
const TAP_DROPPED_KEYS = /^\s*(?:duration_ms|type|failureType):/;
const TAP_INDENT = 4;

/** The YAML block under a test point, from its `---` line to its `...` line; empty when there is none. */
function yamlBlock(lines: readonly string[], start: number, depth: number): { readonly lines: string[]; readonly end: number } {
  const open = lines[start] ?? '';
  if (open.trim() !== '---' || indentOf(open) <= depth) {
    return { lines: [], end: start - 1 };
  }
  const end = upTo(lines, start + 1, (line) => line.trim() === '...' && indentOf(line) === indentOf(open));
  return { lines: lines.slice(start + 1, end), end };
}

/** The YAML of a failed test point without its timing keys, its `stack` cut to the first frames. */
function tapDetails(yaml: readonly string[]): string[] {
  const details: string[] = [];
  for (let index = 0; index < yaml.length; index += 1) {
    const line = yaml[index] ?? '';
    if (TAP_DROPPED_KEYS.test(line)) {
      continue;
    }
    details.push(line);
    if (/^\s*stack: \|-?$/.test(line)) {
      const stop = upTo(yaml, index + 1, (next) => indentOf(next) <= indentOf(line));
      details.push(...chooseFrames(yaml.slice(index + 1, stop)));
      index = stop - 1;
    }
  }
  const depth = Math.min(...details.filter((line) => line.trim() !== '').map(indentOf));
  return details.map((line) => `  ${line.slice(Math.min(depth, indentOf(line)))}`);
}

/**
 * TAP's `not ok` points with their YAML, named by their `# Subtest:` parents, and the comment lines (a
 * test's own output, or a test file's error) printed since the last point. A suite failed only by its
 * children (`failureType: 'subtestsFailed'`) and a `# TODO` or `# SKIP` point are left out.
 */
function tapFailures(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  const parents: string[] = [];
  let notes: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const subtest = TAP_SUBTEST.exec(line);
    const point = TAP_POINT.exec(line);
    if (subtest !== null) {
      parents.splice(Math.floor((subtest[1] ?? '').length / TAP_INDENT), Infinity, subtest[2] ?? '');
    } else if (point !== null) {
      const indent = point[1] ?? '';
      const yaml = yamlBlock(lines, index + 1, indent.length);
      index = yaml.end;
      const suite = yaml.lines.some((row) => row.includes("failureType: 'subtestsFailed'"));
      if (point[2] !== undefined && point[4] === undefined && !suite) {
        const name = [...parents.slice(0, Math.floor(indent.length / TAP_INDENT)), point[3] ?? ''].join(' > ');
        blocks.push([`not ok ${name}`, ...notes, ...tapDetails(yaml.lines)]);
      }
      notes = [];
    } else if (/^\s*#/.test(line) && !TAP_SUMMARY.test(line)) {
      notes.push(`  ${line.trimStart().replace(/^# ?/, '')}`);
    }
  }
  return blocks;
}

const TAP: RunnerReader = {
  runner: 'tap',
  detects: (lines) => lines.some((line) => /^TAP version \d+$/.test(line) || /^# (?:tests|fail)\s+\d+$/.test(line) || /^\s*not ok \d+/.test(line)),
  counts: (lines) => nodeCounts(sums(lines, /^# (tests|fail|cancelled)\s+(\d+)$/)),
  failures: tapFailures,
};

const JEST_HEADER = /^ {2}● (.+)$/;

/** Jest's `●` blocks, each to the next one or the next unindented line; `● Console` blocks are output, not failures. */
function jestFailures(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const header = JEST_HEADER.exec(line);
    if (header !== null) {
      current = header[1] === 'Console' ? null : [line];
      if (current !== null) {
        blocks.push(current);
      }
    } else if (current !== null && isBody(line)) {
      current.push(line);
    } else {
      current = null;
    }
  }
  return blocks;
}

const JEST: RunnerReader = {
  runner: 'jest',
  detects: (lines) => lines.some((line) => /^Tests:\s+/.test(line) || /^Test Suites:\s+/.test(line)),
  counts: (lines) => lineCounts(lines, /^Tests:\s+(.*?)(\d+) total\s*$/),
  failures: jestFailures,
};

const VITEST_HEADER = /^ FAIL {2}\S/;
const VITEST_END = /^⎯+(?:\[\d+\/\d+\]⎯*)?$|^\s+Test Files\s/;

/** Vitest's ` FAIL  <file> > <name>` blocks, each to its `⎯` rule; else the `×` lines of its progress list. */
function vitestFailures(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (VITEST_HEADER.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (VITEST_END.test(line)) {
      current = null;
    } else {
      current?.push(line);
    }
  }
  return blocks.length > 0 ? blocks : lines.filter((line) => /^\s*× /.test(line)).map((line) => [line]);
}

const VITEST: RunnerReader = {
  runner: 'vitest',
  detects: (lines) => lines.some((line) => /^\s*Test Files\s+\d/.test(line) || /⎯ Failed Tests \d+ ⎯/.test(line)),
  counts: (lines) => lineCounts(lines, /^\s*Tests\s+(.*)\((\d+)\)\s*$/),
  failures: vitestFailures,
};

/** Most specific first: Vitest and Jest summaries never look like Node's, and TAP is the loosest match. */
const READERS: readonly RunnerReader[] = [VITEST, JEST, NODE_SPEC, TAP];

/** Stack frames cut to the first ones, and an error's own properties printed after them (`{ code: ... }`) left out. */
function cutFrames(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const stop = upTo(lines, index, (line) => !FRAME.test(line));
    if (stop === index) {
      kept.push(lines[index] ?? '');
      index += 1;
      continue;
    }
    const run = lines.slice(index, stop);
    kept.push(...chooseFrames(run));
    const close = (run.at(-1) ?? '').endsWith('{') ? indexFrom(lines, stop, (line) => line.trim() === '}') : -1;
    index = close === -1 ? stop : close + 1;
  }
  return kept;
}

/** One failing test as text: dedented, frames cut, trailing spaces and repeated blank lines dropped. */
function tidyBlock(block: readonly string[]): string {
  const depth = Math.min(...block.filter((line) => line.trim() !== '').map(indentOf));
  const lines = cutFrames(block.map((line) => line.slice(Math.min(depth, indentOf(line))).trimEnd()));
  return lines
    .filter((line, index) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim();
}
