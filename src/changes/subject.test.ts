import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSubject, shortSha } from './subject.ts';

describe('readSubject', () => {
  it('takes the area from a Conventional Commits scope and the kind from its type', () => {
    const read = readSubject('feat(open): open a console tab on Windows with no terminal (T3272, T3273)');
    assert.equal(read.area, 'open');
    assert.equal(read.kind, 'feature');
    assert.equal(read.text, 'open a console tab on Windows with no terminal');
    assert.deepEqual(read.taskIds, ['T3272', 'T3273']);
    assert.equal(read.hidden, false);
  });

  it('takes any other prefix as the area, and names the pull request numbers', () => {
    const read = readSubject('ship: a ship tool runs only from main (#1373)');
    assert.equal(read.area, 'ship');
    assert.equal(read.kind, 'other');
    assert.deepEqual(read.numbers, ['#1373']);
  });

  it('reads a fix, and a breaking change by its ! or its body line', () => {
    assert.equal(readSubject('fix: x').kind, 'fix');
    assert.equal(readSubject('fix: x').area, 'general');
    assert.equal(readSubject('feat(cli)!: x').kind, 'behaviour');
    assert.equal(readSubject('feat: x', 'Why.\n\nBREAKING CHANGE: --team is required').kind, 'behaviour');
    assert.equal(readSubject('no prefix at all', 'BREAKING-CHANGE: y').kind, 'behaviour');
  });

  it('marks release, build, test and tooling commits hidden, and docs ones not', () => {
    assert.equal(readSubject('plugin: version 0.447.0, x').hidden, true);
    assert.equal(readSubject('plugin: version 0.447.0, x').release, true);
    assert.equal(readSubject('build: rebuild the plugin dist').hidden, true);
    assert.equal(readSubject('test(cli): cover x').hidden, true);
    assert.equal(readSubject('docs: the changes command').hidden, false);
  });

  it('keeps a subject with no prefix whole, in the general area', () => {
    const read = readSubject('Merge the open fixes');
    assert.equal(read.area, 'general');
    assert.equal(read.text, 'Merge the open fixes');
  });
});

describe('shortSha', () => {
  it('cuts a sha to the nine characters every source names a commit by', () => {
    assert.equal(shortSha('9fd4f857100000000'), '9fd4f8571');
  });
});
