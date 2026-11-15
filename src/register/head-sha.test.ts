import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commitsNamed, namesApprovedHead, namesUnapprovedCommit } from './head-sha.ts';

describe('commitsNamed', () => {
  it('reads each run of 7 to 40 hex digits in either case, lowered, and none from no text', () => {
    assert.deepEqual(commitsNamed('Approved 2bd9a4a70: range-diff = vs 9b1920cf4, PR #1101, 10088 tests'), ['2bd9a4a70', '9b1920cf4']);
    assert.deepEqual(commitsNamed('abc123 is short, ABCDEF1 is upper case'), ['abcdef1']);
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
    assert.equal(namesUnapprovedCommit('rebased: approve 301C2359D?', approval), true, 'an upper-case head is a head (T3094)');
  });
});

describe('namesApprovedHead (T3094)', () => {
  const approval = 'Approved head 2bd9a4a70: PASS';

  it('is true only for a note naming the approved head, as fully as the approval or more, in any case', () => {
    assert.equal(namesApprovedHead('merge refused by the classifier, head 2bd9a4a70', approval), true);
    assert.equal(namesApprovedHead('head 2bd9a4a70e1f merges once allowed', approval), true);
    assert.equal(namesApprovedHead('head 2BD9A4A70 merges once allowed', approval), true);
  });

  it('is false for a note naming no commit, the head only in part, or another commit', () => {
    for (const note of [
      'new head ready, please re-approve',
      'merge refused by the classifier, not retried',
      null,
      'head 2bd9a4a, a shorter prefix than the approval wrote',
      'head 2bd9a, under 7 hex digits',
      'see PR #1101 and refs/heads/t3044',
      'rebased: approve 301c2359d?',
      '2bd9a4a70 still holds main 7043b7222',
      'rebased: approve 301C2359D?',
    ]) {
      assert.equal(namesApprovedHead(note, approval), false, String(note));
    }
    assert.equal(namesApprovedHead('head 2bd9a4a70', 'looks good'), false, 'an approval naming no head keeps nothing');
  });
});
