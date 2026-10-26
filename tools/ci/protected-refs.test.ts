import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { protectedPushRefusal } from './protected-refs.ts';

describe('protectedPushRefusal', () => {
  it('refuses a push that updates or deletes main, whatever else it sends', () => {
    const refusal = 'refs/heads/main changes only through a pull request: push a branch of your own and open a pull request from it';
    assert.equal(protectedPushRefusal(['refs/heads/main']), refusal);
    assert.equal(protectedPushRefusal(['refs/heads/topic', 'refs/heads/main']), refusal);
  });

  it('lets a push through that touches no protected branch', () => {
    assert.equal(protectedPushRefusal([]), undefined);
    assert.equal(protectedPushRefusal(['refs/heads/topic', 'refs/heads/main-fix', 'refs/heads/feature/main', 'refs/tags/main']), undefined);
  });
});
