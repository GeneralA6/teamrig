import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { applyIgnore, ignoreLines, ignoreStep, type IgnoreStep, type PointerGit, type PointerInGit } from './pointer-ignore.ts';

const POINTER = resolve('/', 'work', 'shop', '.teamrig.json');
const EXCLUDE = resolve('/', 'work', 'shop', '.git', 'info', 'exclude');
const ADD: IgnoreStep = { kind: 'add', pointer: POINTER, exclude: EXCLUDE };

/** Git that gives one answer and records each path it is asked about. */
class FixedPointerGit implements PointerGit {
  readonly asked: string[] = [];
  private readonly answer: PointerInGit;

  constructor(answer: PointerInGit) {
    this.answer = answer;
  }

  state(path: string): PointerInGit {
    this.asked.push(path);
    return this.answer;
  }
}

describe('ignoreStep', () => {
  it('adds the exclude line for a pointer git neither tracks nor ignores', () => {
    const git = new FixedPointerGit({ kind: 'open', exclude: EXCLUDE });
    assert.deepEqual(ignoreStep(git, POINTER), ADD);
    assert.deepEqual(git.asked, [POINTER]);
  });

  it('leaves a committed or ignored pointer as it is, and does nothing outside git', () => {
    assert.deepEqual(ignoreStep(new FixedPointerGit({ kind: 'tracked' }), POINTER), {
      kind: 'keep',
      pointer: POINTER,
      why: 'it is committed, so every clone gets it; to keep it on this machine only, run git rm --cached .teamrig.json and commit',
    });
    assert.deepEqual(ignoreStep(new FixedPointerGit({ kind: 'ignored' }), POINTER), { kind: 'keep', pointer: POINTER, why: 'git already ignores it' });
    assert.deepEqual(ignoreStep(new FixedPointerGit({ kind: 'no-git' }), POINTER), { kind: 'none' });
  });
});

describe('applyIgnore', () => {
  it('creates a missing exclude file with the line', async () => {
    const files = new MemoryFiles();
    await applyIgnore(files, ADD);
    assert.equal(files.get(EXCLUDE), '.teamrig.json\n');
  });

  it('adds the line after the existing ones, on a line of its own even when the file ends without a newline', async () => {
    const ended = new MemoryFiles({ [EXCLUDE]: '# local\nnode_modules\n' });
    await applyIgnore(ended, ADD);
    assert.equal(ended.get(EXCLUDE), '# local\nnode_modules\n.teamrig.json\n');
    const unended = new MemoryFiles({ [EXCLUDE]: '# local' });
    await applyIgnore(unended, ADD);
    assert.equal(unended.get(EXCLUDE), '# local\n.teamrig.json\n');
  });

  it('writes nothing for a kept pointer or one outside git', async () => {
    const files = new MemoryFiles();
    await applyIgnore(files, { kind: 'keep', pointer: POINTER, why: 'git already ignores it' });
    await applyIgnore(files, { kind: 'none' });
    assert.deepEqual(files.paths(), []);
  });
});

describe('ignoreLines', () => {
  it('says what was added, or would be, what was left, and nothing outside git', () => {
    const added = `.teamrig.json to ${EXCLUDE}: git ignores it in this clone only, as the team it names exists on this machine only`;
    assert.deepEqual(ignoreLines(ADD, false), [`ADDED ${added}`]);
    assert.deepEqual(ignoreLines(ADD, true), [`WOULD ADD ${added}`]);
    assert.deepEqual(ignoreLines({ kind: 'keep', pointer: POINTER, why: 'git already ignores it' }, false), [`UNCHANGED ${POINTER} in git: git already ignores it`]);
    assert.deepEqual(ignoreLines({ kind: 'none' }, false), []);
  });
});
