import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INTERFACE_VERSION, revisionText, type RevisionParts } from './index.ts';

const PARTS: RevisionParts = {
  document: 'tasks',
  args: [
    ['team', 'app'],
    ['owner', null],
  ],
  stamps: ['120:1000', null, '4096:2000'],
};

describe('revisionText', () => {
  it('spells equal parts as the same text', () => {
    const again: RevisionParts = { document: 'tasks', args: [['team', 'app'], ['owner', null]], stamps: ['120:1000', null, '4096:2000'] };

    assert.equal(revisionText(again), revisionText(PARTS));
  });

  it('changes with a stamp', () => {
    assert.notEqual(revisionText({ ...PARTS, stamps: ['121:1000', null, '4096:2000'] }), revisionText(PARTS));
  });

  it('changes when a missing file appears, and when a file goes missing', () => {
    assert.notEqual(revisionText({ ...PARTS, stamps: ['120:1000', '0:1500', '4096:2000'] }), revisionText(PARTS));
    assert.notEqual(revisionText({ ...PARTS, stamps: ['120:1000', null, null] }), revisionText(PARTS));
  });

  it('changes with an argument, and tells one left out from an empty one', () => {
    const owned = revisionText({ ...PARTS, args: [['team', 'app'], ['owner', 'alpha']] });
    const empty = revisionText({ ...PARTS, args: [['team', 'app'], ['owner', '']] });

    assert.notEqual(owned, revisionText(PARTS));
    assert.notEqual(empty, revisionText(PARTS));
  });

  it('changes with the document', () => {
    assert.notEqual(revisionText({ ...PARTS, document: 'inbox' }), revisionText(PARTS));
  });

  it('keeps the parts apart, so a value holding a separator is not read as two', () => {
    const one = revisionText({ ...PARTS, args: [['team', 'app","owner']], stamps: [] });
    const two = revisionText({ ...PARTS, args: [['team', 'app'], ['owner', null]], stamps: [] });

    assert.notEqual(one, two);
  });

  it('carries the interface version, so a newer minor never answers unchanged to an older revision', () => {
    const spelled: unknown = JSON.parse(revisionText(PARTS));

    assert.ok(Array.isArray(spelled));
    assert.equal(spelled[0], INTERFACE_VERSION);
  });
});
