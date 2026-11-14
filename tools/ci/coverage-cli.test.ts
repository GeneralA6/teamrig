import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_COVERAGE_REPORT } from './coverage.ts';

const CLI = fileURLToPath(new URL('./coverage-cli.ts', import.meta.url));

const POLICY = {
  total: { lines: 90, branches: 90, functions: 90 },
  perFile: { lines: 90, branches: 90, functions: 90 },
  testSupport: [],
};

const SOURCE = ['export function sign(n: number): string {', "  return n < 0 ? 'negative' : 'positive';", '}', ''].join('\n');

function testFile(body: string): string {
  return ["import { it } from 'node:test';", "import assert from 'node:assert/strict';", "import { sign } from './sign.ts';", body, ''].join('\n');
}

const FULL_TEST = testFile("it('signs', () => {\n  assert.equal(sign(-1), 'negative');\n  assert.equal(sign(1), 'positive');\n});");

interface GateRun {
  readonly status: number | null;
  readonly output: string;
  /** What the run left in its cwd, which is not the repo it gates. */
  readonly strays: readonly string[];
}

/**
 * Gates a throwaway repo with one source file and its test, plus the given overrides (`null` leaves a file out),
 * through `--root` from a folder outside it.
 */
function gate(files: Readonly<Record<string, string | null>>, env: NodeJS.ProcessEnv = process.env): GateRun {
  const base = mkdtempSync(join(tmpdir(), 'teamrig-coverage-gate-'));
  const repo = join(base, 'repo');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(repo);
  mkdirSync(elsewhere);
  try {
    const all: Record<string, string | null> = {
      'package.json': '{ "type": "module" }\n',
      'tools/ci/coverage.json': JSON.stringify(POLICY),
      'src/sign.ts': SOURCE,
      'src/sign.test.ts': FULL_TEST,
      ...files,
    };
    for (const [path, content] of Object.entries(all)) {
      if (content !== null) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
    }
    const init = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const result = spawnSync(process.execPath, [CLI, '--root', repo], { cwd: elsewhere, encoding: 'utf8', env });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, strays: readdirSync(elsewhere) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe('coverage-cli', () => {
  it('passes a fully tested --root repo, run from another folder, and prints the totals', () => {
    const { status, output, strays } = gate({});
    assert.equal(status, 0, output);
    assert.match(output, /coverage: 1 tests; 1 files: lines 100%, branches 100%, functions 100%/);
    assert.deepEqual(strays, []);
  });

  it('exits 2 on an unknown option before it runs anything', () => {
    const result = spawnSync(process.execPath, [CLI, '--fix'], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.stderr, 'coverage: unknown option --fix (usage: coverage-cli.ts [--root <repo>])\n');
  });

  it('fails a new file that no test loads, before it is committed', () => {
    const { status, output } = gate({ 'src/extra.ts': 'export const EXTRA = 1;\n' });
    assert.equal(status, 1, output);
    assert.match(output, /src\/extra\.ts: no test loads it/);
  });

  it('fails a file whose branch no test takes', () => {
    const { status, output } = gate({ 'src/sign.test.ts': testFile("it('signs', () => {\n  assert.equal(sign(1), 'positive');\n});") });
    assert.equal(status, 1, output);
    assert.match(output, /src\/sign\.ts: branches \d+(\.\d)?% < 90%/);
  });

  it('fails a failing test and a skipped test', () => {
    const failing = gate({ 'src/sign.test.ts': `${FULL_TEST}it('breaks', () => {\n  assert.equal(sign(1), 'negative');\n});\n` });
    assert.equal(failing.status, 1, failing.output);
    assert.match(failing.output, /1 failing and 0 cancelled test\(s\)/);
    const skipped = gate({ 'src/sign.test.ts': `${FULL_TEST}it.skip('later', () => {});\n` });
    assert.equal(skipped.status, 1, skipped.output);
    assert.match(skipped.output, /1 skipped and 0 todo test\(s\)/);
  });

  it('fails a suite whose body throws before any of its tests runs, which node counts as no failure', () => {
    const thrown = gate({
      'src/sign.test.ts': `${FULL_TEST}import { describe } from 'node:test';\ndescribe('built wrong', () => {\n  throw new Error('a constant moved');\n});\n`,
    });
    assert.equal(thrown.status, 1, thrown.output);
    assert.match(thrown.output, /1 suite\(s\) failed outside any test, which the run counted as no failure \(the error is above\): built wrong/);
  });

  it('names a coverage file cut short as the cause of a run with no report, with no line per file', () => {
    // A child process killed while it writes its coverage file at its exit leaves one cut short, which Node cannot read.
    const cut = [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "writeFileSync(join(process.env.NODE_V8_COVERAGE ?? '', 'coverage-1-1700000000000-1.json'), '{\"result\":[');",
      '',
    ].join('\n');
    // The inner run gets a coverage folder of its own: it copies its files to the one it was given as it ends, the cut
    // one too, which in this run's folder would fail this run. Leaving the variable out is not enough, since Node gives
    // a child its parent's NODE_V8_COVERAGE whenever the env passed to it does not name one.
    const coverage = mkdtempSync(join(tmpdir(), 'teamrig-coverage-cut-'));
    try {
      const { status, output } = gate({ 'src/sign.test.ts': `${FULL_TEST}${cut}` }, { ...process.env, NODE_V8_COVERAGE: coverage });
      assert.equal(status, 1, output);
      assert.match(output, /Could not report code coverage/);
      assert.ok(output.includes(NO_COVERAGE_REPORT), output);
      assert.doesNotMatch(output, /no test loads it/);
    } finally {
      rmSync(coverage, { recursive: true, force: true });
    }
  });

  it('stops a suite that prints nothing for the idle limit and fails it as hung', () => {
    const never = testFile("it('never ends', async () => {\n  setInterval(() => {}, 1000);\n  await new Promise(() => {});\n});");
    const { status, output } = gate({ 'tools/ci/coverage.json': JSON.stringify({ ...POLICY, suiteIdleSeconds: 2 }), 'src/sign.test.ts': never });
    assert.equal(status, 1, output);
    // A busy host gives the run the 2 s limit up to three times.
    assert.match(output, /coverage: the test run printed nothing for [246] s and was stopped with every process it started/);
  });

  it('exits 2 on an invalid or missing policy', () => {
    const invalid = gate({ 'tools/ci/coverage.json': JSON.stringify({ ...POLICY, totals: {} }) });
    assert.equal(invalid.status, 2, invalid.output);
    assert.match(invalid.output, /coverage: tools\/ci\/coverage\.json: unknown key "totals"/);
    const missing = gate({ 'tools/ci/coverage.json': null });
    assert.equal(missing.status, 2, missing.output);
    assert.match(missing.output, /^coverage: /m);
  });
});
