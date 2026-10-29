import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { plainWordsOf } from './route-line.ts';

describe('plainWordsOf', () => {
  it('gives the words of one plain command, after quote removal', () => {
    assert.deepEqual(plainWordsOf('teamrig merge --session tr-x'), ['teamrig', 'merge', '--session', 'tr-x']);
    assert.deepEqual(plainWordsOf(`git commit -s -m 'fix: the "a" case'`), ['git', 'commit', '-s', '-m', 'fix: the "a" case']);
    assert.deepEqual(plainWordsOf('  git\tstatus  '), ['git', 'status']);
    assert.deepEqual(plainWordsOf(`git commit -m ''`), ['git', 'commit', '-m', '']);
  });

  it('takes a standalone 2>&1, and only that redirection', () => {
    assert.deepEqual(plainWordsOf('git push origin t1-x 2>&1'), ['git', 'push', 'origin', 't1-x']);
    assert.deepEqual(plainWordsOf('2>&1 git status'), ['git', 'status']);
    for (const line of ['git status 2>/dev/null', 'git status >&2', 'git status 2>&1x', 'git status x2>&1', 'git status 1>&2', 'git status &>/dev/null']) {
      assert.equal(plainWordsOf(line), undefined, line);
    }
  });

  it('refuses text that may join, feed, redirect or substitute another command, quoted or not', () => {
    for (const line of [
      'git status; rm -rf x',
      'git status && git push',
      'git status | tail',
      'git status &',
      'git status > out',
      'git status < in',
      'git status <<EOF',
      'echo `id`',
      'echo $(id)',
      'echo ${B}',
      `git commit -m 'a; b'`,
      `git commit -m "a > b"`,
      `git commit -m 'a|b'`,
      `git commit -m 'a $(b)'`,
    ]) {
      assert.equal(plainWordsOf(line), undefined, line);
    }
  });

  it('refuses a control character: a newline, a carriage return, a NUL, a DEL', () => {
    for (const line of ['git status\ngit push', 'git status\r', 'git\u0000status', 'git status\u007f', 'git \\\nstatus']) {
      assert.equal(plainWordsOf(line), undefined, JSON.stringify(line));
    }
  });

  it('refuses a word only known when it runs, or one bash expands', () => {
    for (const line of ['git push $R t1-x', 'git push "$R" t1-x', 'ls *.ts', 'ls a?b', 'ls [ab]', 'cat ~/x', 'echo {a,b}', 'echo $1']) {
      assert.equal(plainWordsOf(line), undefined, line);
    }
  });

  it('refuses a line it cannot read whole, a subshell, a leading assignment, an empty line', () => {
    for (const line of [`git commit -m 'open`, '(git status)', '{ git status; }','GIT_DIR=/x git push origin t1-x', '', '   ', 'echo $((1 + 2))']) {
      assert.equal(plainWordsOf(line), undefined, JSON.stringify(line));
    }
  });

  it('refuses a word that holds a substitution an expansion may run again', () => {
    assert.equal(plainWordsOf(`printf -v 'a[$(id)]' x`), undefined);
  });
});
