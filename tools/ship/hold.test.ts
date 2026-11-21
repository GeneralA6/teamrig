import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { holdHead, type HoldDeps } from './hold.ts';

describe('holdHead', () => {
  let repo: TempRepo;
  let deps: HoldDeps;
  let logs: string[];

  beforeEach(() => {
    repo = new TempRepo('hold').init();
    repo.write('a.txt', 'a\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'a');
    logs = [];
    deps = { git: (...args) => repo.git(...args).trim(), log: (line) => logs.push(line) };
  });
  afterEach(() => repo.remove());

  it('puts the branch back on its head with the plan uncommitted, after a take back, a move to another commit and a partial commit', () => {
    repo.write('b.txt', 'b\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'core: b');
    const head = repo.git('rev-parse', 'HEAD').trim();
    repo.write('a.txt', 'a changed, uncommitted\n');
    repo.write('new.txt', 'new, untracked\n');
    const held = holdHead(deps);
    assert.equal(held.head, head);

    // What a run does before it stops: takes back its commit, moves onto a main that adds a file, commits part of the plan.
    repo.git('reset', '-q', 'HEAD~1');
    repo.git('stash', '-q');
    repo.write('main.txt', 'main\n');
    repo.git('add', 'main.txt');
    repo.git('commit', '-q', '-m', 'main moves');
    repo.git('add', 'new.txt');
    repo.git('commit', '-q', '-m', 'core: new');

    held.restore();
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), head);
    assert.equal(readFileSync(join(repo.dir, 'a.txt'), 'utf8'), 'a changed, uncommitted\n');
    assert.equal(readFileSync(join(repo.dir, 'b.txt'), 'utf8'), 'b\n');
    assert.equal(readFileSync(join(repo.dir, 'new.txt'), 'utf8'), 'new, untracked\n');
    assert.equal(repo.has('main.txt'), false);
    assert.deepEqual(repo.git('status', '--porcelain').split('\n').filter((row) => row !== '').sort(), [' M a.txt', '?? new.txt']);
    assert.match(logs.at(-1) ?? '', /^the branch is back on [0-9a-f]{9}, the head this run started from, with the plan uncommitted on it$/);
  });

  it('cleans a stray whose name is a glob as that one file, leaving the untracked plan file it would match', () => {
    // `[n]ew.txt` rather than `*`, which Windows refuses as a file name; both match new.txt as a glob.
    repo.write('a.txt', 'a changed, uncommitted\n');
    repo.write('new.txt', 'new, untracked\n');
    const held = holdHead(deps);
    repo.write('[n]ew.txt', 'a file main adds\n');
    repo.git('add', '--', ':(literal)[n]ew.txt');
    repo.git('commit', '-q', '-m', 'main adds a file named like a glob');

    held.restore();
    assert.equal(readFileSync(join(repo.dir, 'new.txt'), 'utf8'), 'new, untracked\n');
    assert.equal(repo.has('[n]ew.txt'), false);
    assert.match(logs[0] ?? '', /^held the plan's uncommitted changes as [0-9a-f]{40} \(git stash apply [0-9a-f]{40} brings them back\)$/);
  });

  it('with nothing uncommitted, puts back only the head', () => {
    const head = repo.git('rev-parse', 'HEAD').trim();
    const held = holdHead(deps);
    repo.write('c.txt', 'c\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'c');
    held.restore();
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), head);
    assert.equal(repo.git('status', '--porcelain'), '');
  });
});
