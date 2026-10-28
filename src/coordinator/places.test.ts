import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { coordinatorDirOf, teamPlace } from './places.ts';

const HOME = resolve('kit', 'teams', 'app');
const STATE = join(HOME, 'state');

describe('teamPlace', () => {
  it("puts a relative path in the team's folder and keeps an absolute one", () => {
    assert.equal(teamPlace({ home: HOME }, 'deploys'), join(HOME, 'deploys'));
    const absolute = resolve('shared', 'deploys');
    assert.equal(teamPlace({ home: HOME }, absolute), absolute);
  });
});

describe('coordinatorDirOf', () => {
  it("is <state>/deploys when coordinator.dir is unset, and coordinator.dir in the team's folder when set", () => {
    assert.equal(coordinatorDirOf({}, { home: HOME, state: STATE }), join(STATE, 'deploys'));
    assert.equal(coordinatorDirOf({ dir: 'ledger' }, { home: HOME, state: STATE }), join(HOME, 'ledger'));
    const absolute = resolve('shared', 'deploys');
    assert.equal(coordinatorDirOf({ dir: absolute }, { home: HOME, state: STATE }), absolute);
  });
});
