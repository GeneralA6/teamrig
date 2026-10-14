import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** A throwaway repo with one source file and its test, plus the given overrides (`null` leaves a file out). */
function gate(files: Readonly<Record<string, string | null>>): { readonly status: number | null; readonly output: string } {
  const repo = mkdtempSync(join(tmpdir(), 'teamrig-coverage-gate-'));
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
    const result = spawnSync(process.execPath, [CLI], { cwd: repo, encoding: 'utf8', env: process.env });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('coverage-cli', () => {
  it('passes a fully tested repo and prints the totals', () => {
    const { status, output } = gate({});
    assert.equal(status, 0, output);
    assert.match(output, /coverage: 1 tests; 1 files: lines 100%, branches 100%, functions 100%/);
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

  it('exits 2 on an invalid or missing policy', () => {
    const invalid = gate({ 'tools/ci/coverage.json': JSON.stringify({ ...POLICY, totals: {} }) });
    assert.equal(invalid.status, 2, invalid.output);
    assert.match(invalid.output, /coverage: tools\/ci\/coverage\.json: unknown key "totals"/);
    const missing = gate({ 'tools/ci/coverage.json': null });
    assert.equal(missing.status, 2, missing.output);
    assert.match(missing.output, /^coverage: /m);
  });
});
