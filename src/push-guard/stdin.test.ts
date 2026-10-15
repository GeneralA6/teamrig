import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './launchers.ts';
import { stdinUse, type StdinUse } from './stdin.ts';
import { parseShell } from './tokenizer.ts';

/** What the first command of a bash line does with what it reads on stdin. */
function use(line: string): StdinUse {
  const command = parseShell(line, 'bash').commands[0];
  assert.ok(command !== undefined, line);
  return stdinUse(command, launch(command.words, 'bash', command.stdin));
}

function expectUse(lines: readonly string[], expected: StdinUse): void {
  for (const line of lines) {
    assert.equal(use(line), expected, line);
  }
}

describe('stdinUse', () => {
  it('stores what a plain cat writes to a named file', () => {
    expectUse(['cat > notes.md', 'cat >> notes.md', 'cat - >| n', 'cat 1> n', 'cat >&2 > n', 'env cat > n 2> err'], 'stored');
  });

  it('passes what a plain cat writes down a pipe', () => {
    expectUse(['cat | bash', 'cat |& bash', 'cat - 2> err | x'], 'passed');
  });

  it('reads it otherwise: another program, an argument, the terminal, a device or a file only known when it runs', () => {
    expectUse(['cat', 'cat; x', 'cat x | bash', 'tee n', 'xargs cat > n', '$C > n'], 'read');
    expectUse(['cat > /dev/stdout', 'cat > /proc/self/fd/1', 'cat > "$F"', 'cat > n >&2', 'cat > n 1>&2 | x'], 'read');
  });
});
