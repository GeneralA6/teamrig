import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf, type SourceNames } from './index.ts';

const NAMES: SourceNames = {
  owner: 'owner',
  connectors: [{ id: 'tracker', name: 'Tracker' }],
  nameOf: (session) => new Map([['alpha', 'app-alpha']]).get(session),
};

describe('a served source', () => {
  it('tells the owner, a session and a connector apart', () => {
    assert.deepEqual(sourceOf('owner', NAMES), { kind: 'owner', id: 'owner', name: 'owner' });
    assert.deepEqual(sourceOf('alpha', NAMES), { kind: 'session', id: 'alpha', name: 'app-alpha' });
    assert.deepEqual(sourceOf('tracker', NAMES), { kind: 'connector', id: 'tracker', name: 'Tracker' });
  });

  it('keeps a session the team no longer lists, and one of another team, as a session named by its id', () => {
    assert.deepEqual(sourceOf('retired', NAMES), { kind: 'session', id: 'retired', name: 'retired' });
    assert.deepEqual(sourceOf('parent/po', NAMES), { kind: 'session', id: 'parent/po', name: 'parent/po' });
  });

  it('reads the owner\'s marker from the team, before any connector or session of that name', () => {
    const names: SourceNames = { owner: 'boss', connectors: [{ id: 'boss', name: 'Boss tracker' }], nameOf: () => 'a session' };
    assert.deepEqual(sourceOf('boss', names), { kind: 'owner', id: 'boss', name: 'boss' });
    assert.deepEqual(sourceOf('owner', names), { kind: 'session', id: 'owner', name: 'a session' });
  });
});
