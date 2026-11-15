import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commitsNamed, namesUnapprovedCommit } from './head-sha.ts';

describe('commitsNamed', () => {
  it('reads each run of 7 to 40 lowercase hex digits, and none from no text', () => {
    assert.deepEqual(commitsNamed('Approved 2bd9a4a70: range-diff = vs 9b1920cf4, PR #1101, 10088 tests'), ['2bd9a4a70', '9b1920cf4']);
    assert.deepEqual(commitsNamed('abc123 is short, ABCDEF1 is upper case'), []);
    assert.deepEqual(commitsNamed(null), []);
  });
});

describe('namesUnapprovedCommit', () => {
  const approval = 'Approved 2bd9a4a70: PASS';

  it('is false for a note naming no commit, or only the approved one, abbreviated either way', () => {
    assert.equal(namesUnapprovedCommit('merge denied by the classifier, not retried', approval), false);
    assert.equal(namesUnapprovedCommit('2bd9a4a70e1f merges once allowed', approval), false);
    assert.equal(namesUnapprovedCommit('2bd9a4a merges once allowed', approval), false);
  });

  it('is true for a note naming another commit, and for any commit when the approval names none', () => {
    assert.equal(namesUnapprovedCommit('rebased: approve 301c2359d?', approval), true);
    assert.equal(namesUnapprovedCommit('2bd9a4a70 still holds main 7043b7222', approval), true);
    assert.equal(namesUnapprovedCommit('approve 301c2359d?', 'looks good'), true);
    assert.equal(namesUnapprovedCommit('approve 301c2359d?', null), true);
  });
});
