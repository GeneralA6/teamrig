import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clipEnd, clipStart } from './clip.ts';

describe('clipEnd', () => {
  it('keeps text that fits and cuts longer text at its end, the "..." counted in', () => {
    assert.equal(clipEnd('short', 5), 'short');
    assert.equal(clipEnd('a longer line', 8), 'a lon...');
    assert.equal(clipEnd('a longer line', 8).length, 8);
  });
});

describe('clipStart', () => {
  it('keeps text that fits and cuts longer text at its start, the "..." counted in', () => {
    assert.equal(clipStart('/a/b.md', 7), '/a/b.md');
    assert.equal(clipStart('/deep/folder/CLAUDE.md', 12), '...CLAUDE.md');
  });
});
