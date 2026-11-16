import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_SOURCE_IDS, isChangeSourceId } from './ids.ts';
import { CHANGE_SOURCES } from './registry.ts';

describe('the change source registry', () => {
  it('holds one source per id, in the ids order', () => {
    assert.deepEqual(
      CHANGE_SOURCES.map((source) => source.id),
      [...CHANGE_SOURCE_IDS],
    );
  });

  it('knows only its own ids', () => {
    assert.equal(isChangeSourceId('git'), true);
    assert.equal(isChangeSourceId('keep-a-changelog'), false);
  });
});
