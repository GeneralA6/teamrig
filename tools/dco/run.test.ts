import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { FakeGit } from '../lib/fake-git.ts';
import { checkMessageFile, checkRange, type DcoDeps } from './run.ts';

const LOG_ARGS = 'log --format=%H%x00%an%x00%ae%x00%P%x00%B%x1e';
const SIGNED = 'Signed-off-by: Alpha <alpha@example.com>';

function deps(gitResponses: Readonly<Record<string, string>>, files: Readonly<Record<string, string>> = {}) {
  const lines: string[] = [];
  const value: DcoDeps = {
    git: new FakeGit(gitResponses),
    readText: async (path) => files[path] ?? '',
    out: (line) => lines.push(line),
  };
  return { value, lines };
}

function record(sha: string, email: string, parents: string, message: string): string {
  return `${sha}\x00Name\x00${email}\x00${parents}\x00${message}\x1e\n`;
}

describe('checkMessageFile', () => {
  const ident = { 'var GIT_AUTHOR_IDENT': 'Alpha <alpha@example.com> 1700000000 +0000\n' };

  it('accepts a message signed off by the author', async () => {
    const { value } = deps(ident, { MSG: `feat: x\n\n${SIGNED}\n` });
    assert.equal(await checkMessageFile('MSG', value), EXIT_CLEAN);
  });

  it('rejects a message without a sign-off and says how to add one', async () => {
    const { value, lines } = deps(ident, { MSG: 'feat: x\n' });
    assert.equal(await checkMessageFile('MSG', value), EXIT_FINDINGS);
    assert.match(lines.join('\n'), /git commit -s/);
  });
});

describe('checkRange', () => {
  it('passes when every non-merge commit is signed off and skips merges', async () => {
    const log =
      record('a'.repeat(40), 'alpha@example.com', 'p', `one\n\n${SIGNED}\n`) +
      record('b'.repeat(40), 'alpha@example.com', 'p1 p2', 'Merge without sign-off\n');
    const { value, lines } = deps({ [`${LOG_ARGS} base..head --`]: log });
    assert.equal(await checkRange('base..head', value), EXIT_CLEAN);
    assert.deepEqual(lines, ['dco: 1 commit(s) signed off']);
  });

  it('names each commit that is not signed off', async () => {
    const log =
      record('a'.repeat(40), 'alpha@example.com', 'p', `one\n\n${SIGNED}\n`) +
      record('c'.repeat(40), 'alpha@example.com', 'p', 'two\n');
    const { value, lines } = deps({ [`${LOG_ARGS} head --`]: log });
    assert.equal(await checkRange('head', value), EXIT_FINDINGS);
    assert.deepEqual(lines, [
      `dco: ${'c'.repeat(12)} no Signed-off-by line; commit with \`git commit -s\``,
      'dco: 1 of 2 commit(s) not signed off',
    ]);
  });
});
