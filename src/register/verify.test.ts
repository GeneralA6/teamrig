import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { proofOf } from './verify.ts';

describe('proofOf', () => {
  it('reads the proof a task was set verifying with', () => {
    assert.equal(proofOf({ proof: 'the nightly run', note: 'Proof: something else' }), 'the nightly run');
  });

  it('reads an older task, set verifying before --proof, from what its note says after Proof', () => {
    assert.equal(proofOf({ proof: null, note: 'shipped in 1.2.0. Proof: the nightly run is green' }), 'the nightly run is green');
    assert.equal(proofOf({ proof: null, note: 'shipped; proof = a real line in the inbox' }), 'a real line in the inbox');
    assert.equal(proofOf({ proof: null, note: 'shipped, proof:   ' }), 'shipped, proof:   ', 'nothing after it: the whole note');
    assert.equal(proofOf({ proof: null, note: 'the nightly run is green' }), 'the nightly run is green');
    assert.equal(proofOf({ proof: null, note: null }), null);
  });
});
