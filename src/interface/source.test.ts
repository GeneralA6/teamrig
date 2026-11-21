import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { cutText, ServedText, sourceOf, type ServedSource, type SourceNames } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

const NAMES: SourceNames = {
  owner: 'owner',
  connectors: [{ id: 'tracker', name: 'Tracker' }],
  nameOf: (session) => new Map([['alpha', 'app-alpha']]).get(session),
};

function servedOf(source: string, names: SourceNames = NAMES): ServedSource {
  return sourceOf(new ServedText(new SecretScanner()), 'T1', source, names);
}

describe('a served source', () => {
  it('tells the owner, a session and a connector apart', () => {
    assert.deepEqual(servedOf('owner'), { kind: 'owner', id: 'owner', name: 'owner' });
    assert.deepEqual(servedOf('alpha'), { kind: 'session', id: 'alpha', name: 'app-alpha' });
    assert.deepEqual(servedOf('tracker'), { kind: 'connector', id: 'tracker', name: 'Tracker' });
  });

  it('keeps a session the team no longer lists, and one of another team, as a session named by its id', () => {
    assert.deepEqual(servedOf('retired'), { kind: 'session', id: 'retired', name: 'retired' });
    assert.deepEqual(servedOf('parent/po'), { kind: 'session', id: 'parent/po', name: 'parent/po' });
  });

  it('cuts a session\'s name that holds a secret shape, under the task it is the source of', () => {
    const scanner = new SecretScanner();
    const shape = scanner.find(SECRET)?.description ?? '';
    const served = new ServedText(scanner);
    const source = sourceOf(served, 'T7', 'alpha', { ...NAMES, nameOf: () => SECRET });
    assert.deepEqual(source, { kind: 'session', id: 'alpha', name: cutText(shape) });
    assert.deepEqual(served.cuts, [{ id: 'T7', field: 'source.name', shape }]);
  });

  it('reads the owner\'s marker from the team, before any connector or session of that name', () => {
    const names: SourceNames = { owner: 'boss', connectors: [{ id: 'boss', name: 'Boss tracker' }], nameOf: () => 'a session' };
    assert.deepEqual(servedOf('boss', names), { kind: 'owner', id: 'boss', name: 'boss' });
    assert.deepEqual(servedOf('owner', names), { kind: 'session', id: 'owner', name: 'a session' });
  });
});
