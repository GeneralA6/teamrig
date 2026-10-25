import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bareName, isReservedName, NAME_PATTERN, RESERVED_NAMES, sessionDisplay, titleKey, titleParts } from './ids.ts';

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

describe('bareName', () => {
  it("drops the team's prefix from a default name", () => {
    assert.equal(bareName('app', 'app-lead'), 'lead');
    assert.equal(bareName('app', 'app-ui-pane'), 'ui-pane');
  });

  it('keeps a name with no such prefix, one that is only the prefix, and one whose team merely starts it', () => {
    assert.equal(bareName('app', 'web'), 'web');
    assert.equal(bareName('app', 'app-'), 'app-');
    assert.equal(bareName('shop', 'shopper-web'), 'shopper-web');
    assert.equal(bareName('app', 'teamrig-pane'), 'teamrig-pane');
  });
});

describe('sessionDisplay', () => {
  it('puts the team once, in brackets, before the bare name', () => {
    assert.equal(sessionDisplay('app', 'app-ui-pane'), '[app] ui-pane');
    assert.equal(sessionDisplay('app', 'web'), '[app] web');
  });
});

describe('titleParts', () => {
  it('splits a display title into its team, lowercased, and its name', () => {
    assert.deepEqual(titleParts('[app] ui-pane'), { team: 'app', name: 'ui-pane' });
    assert.deepEqual(titleParts(' [App]  Lead '), { team: 'app', name: 'Lead' });
  });

  it('reads back what sessionDisplay writes', () => {
    assert.deepEqual(titleParts(sessionDisplay('app', 'app-lead')), { team: 'app', name: 'lead' });
  });

  it('keeps any other title whole, as a bare name', () => {
    for (const title of ['Fix the build', 'web', '[not a team] web', '[app]', '[] web', '[app]web']) {
      assert.deepEqual(titleParts(title), { team: undefined, name: title });
    }
  });
});
