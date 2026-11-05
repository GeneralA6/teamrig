import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING_QUOTES } from '../testing/ansi-c-quotes.ts';
import { rerunForm } from './rerun-forms.ts';

describe('rerunForm', () => {
  it('runs the commands after a leading cd in its folder: git through -C, anything else through env -C', () => {
    assert.equal(rerunForm('Bash', 'cd /w && git status'), 'git -C /w status');
    assert.equal(rerunForm('Bash', 'cd /w && npm test'), 'env -C /w npm test');
    assert.equal(rerunForm('Bash', 'cd /w && CI=1 git log -1'), 'env -C /w CI=1 git log -1');
    assert.equal(rerunForm('Bash', "cd '/my dir' && git status"), "git -C '/my dir' status");
  });

  it('keeps the separators and their order, a newline as a semicolon', () => {
    assert.equal(rerunForm('Bash', 'cd /w && git fetch && git status -sb'), 'git -C /w fetch && git -C /w status -sb');
    assert.equal(rerunForm('Bash', 'cd /w && npm test | tail -5'), 'env -C /w npm test | env -C /w tail -5');
    assert.equal(rerunForm('Bash', 'cd /w && git status\ngit log -1'), 'git -C /w status; git -C /w log -1');
    assert.equal(rerunForm('Bash', 'cd /w && git status;'), 'git -C /w status');
  });

  it('keeps a redirection that reaches the same file from any folder', () => {
    assert.equal(rerunForm('Bash', 'cd /w && npm test 2>&1 | tail -5'), 'env -C /w npm test 2>&1 | env -C /w tail -5');
    assert.equal(rerunForm('Bash', 'cd /w && git status 2>/dev/null'), 'git -C /w status 2>/dev/null');
  });

  it('runs a plain git worktree remove through teamrig, which unlinks shared folders first', () => {
    assert.equal(rerunForm('Bash', 'git worktree remove /w/x'), 'teamrig worktree remove /w/x');
    assert.equal(rerunForm('Bash', 'cd /w && git worktree remove ../x'), 'env -C /w teamrig worktree remove ../x');
  });

  it("writes a word behind a $'...' string whose value is nothing as the word bash gives the program", () => {
    for (const quote of NOTHING_QUOTES) {
      assert.equal(rerunForm('Bash', `cd /w && git ${quote}status`), 'git -C /w status', quote);
      assert.equal(rerunForm('Bash', `cd ${quote}/w && ${quote}git status`), 'git -C /w status', quote);
      assert.equal(rerunForm('Bash', `git ${quote}worktree remove /w/x`), 'teamrig worktree remove /w/x', quote);
    }
  });

  it('gives no form when no rule applies', () => {
    for (const command of ['git status', 'rm -rf x', 'cd /w', 'cd /w; git status', 'git worktree remove --force /w/x', 'git worktree remove']) {
      assert.equal(rerunForm('Bash', command), undefined, command);
    }
    assert.equal(rerunForm('PowerShell', 'cd /w && git status'), undefined);
    assert.equal(rerunForm(undefined, 'cd /w && git status'), undefined);
  });

  it('gives no form when the form could do something else', () => {
    const doubts = [
      'cd /w && ls *.ts',
      'cd ~/w && git status',
      'cd /w && cat ~/.profile',
      'cd /w && echo $(pwd)',
      'cd /w && echo "$HOME"',
      'cd /w && (git status)',
      'cd /w && git status &',
      'cd /w && git status > out.txt',
      'cd /w && sort < in.txt',
      'cd /w && cat <<EOF\nx\nEOF',
      'cd /w && cd src && ls',
      'cd /w && export A=1',
      'cd /w && source env.sh',
      'cd - && git status',
      'cd -P /w && git status',
      'cd /w || git status',
      "cd /w && git log 'unclosed",
    ];
    for (const command of doubts) {
      assert.equal(rerunForm('Bash', command), undefined, command);
    }
  });
});
