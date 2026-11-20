import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reasonOf, stateReasonOf } from './resolution.ts';

describe('why a Jira issue closed', () => {
  it("reads a resolution's name as the reason Jira's templates mean by it, its case and outer blanks aside", () => {
    assert.equal(reasonOf('Done'), 'completed');
    assert.equal(reasonOf(' FIXED '), 'completed');
    assert.equal(reasonOf("Won't Do"), 'not-planned');
    assert.equal(reasonOf('Cannot Reproduce'), 'not-planned');
    assert.equal(reasonOf('Duplicate'), 'duplicate');
  });

  it('reads a typographic apostrophe as a typed one', () => {
    assert.equal(reasonOf('Won’t Fix'), 'not-planned');
  });

  it('gives no reason for a name on no list, and for none', () => {
    assert.equal(reasonOf('Shipped to the moon'), undefined);
    assert.equal(reasonOf('Closed'), undefined);
    assert.equal(reasonOf(''), undefined);
  });

  it("holds a closed issue's reason in the port's word, and a name it does not know as it is", () => {
    assert.equal(stateReasonOf('Done'), 'COMPLETED');
    assert.equal(stateReasonOf("Won't Do"), 'NOT_PLANNED');
    assert.equal(stateReasonOf('duplicate'), 'DUPLICATE');
    assert.equal(stateReasonOf('Shipped to the moon'), 'Shipped to the moon');
    assert.equal(stateReasonOf(''), '');
  });
});
