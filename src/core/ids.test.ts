import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isReservedName, NAME_PATTERN, RESERVED_NAMES, titleKey } from './ids.ts';

describe('isReservedName', () => {
  it("holds the names Claude Code's SendMessage keeps for itself, each a valid name", () => {
    assert.deepEqual(['main', 'team-lead', 'user', 'system'].filter(isReservedName), [...RESERVED_NAMES]);
    assert.ok(RESERVED_NAMES.every((name) => NAME_PATTERN.test(name)));
  });

  it('lets every other name through, one holding a reserved name too', () => {
    assert.deepEqual(['app-lead', 'team-lead-2', 'mainline', 'app-user'].filter(isReservedName), []);
  });
});

describe('titleKey', () => {
  it('reads a title that is a valid name but for its case as that name', () => {
    assert.equal(titleKey('Shop-Web'), 'shop-web');
    assert.equal(titleKey('shop-web'), 'shop-web');
  });

  it('keeps any other title as typed', () => {
    assert.equal(titleKey('Fix the build'), 'Fix the build');
    assert.equal(titleKey('9Lives'), '9Lives');
  });
});
