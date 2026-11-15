import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnRun } from './spawn-run.ts';

/** Prints its stdin, its first argument and its working folder, and exits with the second. */
const ECHO = `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  console.log(input + '|' + process.argv[1] + '|' + process.cwd() + '|' + process.env.SPAWN_RUN_MARK);
  console.error('to stderr');
  process.exitCode = Number(process.argv[2]);
});`;

describe('spawnRun', () => {
  it('hands the program its stdin, arguments, folder and environment, and returns its exit and output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'spawn-run-'));
    try {
      const result = spawnRun(
        { file: process.execPath, args: ['-e', ECHO, 'first', '3'], input: 'stdin' },
        { env: { ...process.env, SPAWN_RUN_MARK: 'marked' }, cwd, timeout: 30_000 },
      );
      assert.equal(result.status, 3);
      const [input, arg, folder, mark] = result.stdout.trim().split('|');
      assert.deepEqual([input, arg, mark], ['stdin', 'first', 'marked']);
      assert.equal(folder?.toLowerCase(), cwd.toLowerCase());
      assert.equal(result.stderr.trim(), 'to stderr');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('passes a verbatim argument to Windows as written, where Node would quote it again; elsewhere it is plain', () => {
    const argOf = (verbatim: boolean): string =>
      spawnRun(
        { file: process.execPath, args: ['-e', 'console.log(process.argv[1])', '"a b"'], input: '', verbatim },
        { env: process.env, cwd: tmpdir(), timeout: 30_000 },
      ).stdout.trim();
    assert.equal(argOf(true), process.platform === 'win32' ? 'a b' : '"a b"');
    assert.equal(argOf(false), '"a b"');
  });

  it('answers a program that cannot start with no exit and the error as its stderr', () => {
    const missing = join(tmpdir(), 'spawn-run-no-such-program');
    const result = spawnRun({ file: missing, args: [], input: '' }, { env: process.env, cwd: tmpdir(), timeout: 30_000 });
    assert.equal(result.status, null);
    assert.match(result.stderr, /ENOENT/);
  });
});
