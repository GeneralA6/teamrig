import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { pausableOf } from './pause.ts';

const IDS = ['lead', 'alpha', 'bravo'];

describe('pausableOf', () => {
  it('pauses no session while budget.pauseByPriority is off', () => {
    assert.deepEqual([...pausableOf(testConfig({ roles: { lead: 'lead', coordinatorOwner: 'alpha' } }), 'app', IDS)], []);
  });

  it('may pause every session but the lead and the coordinator owner the team holds', () => {
    const config = testConfig({ budget: { pauseByPriority: true }, roles: { lead: 'lead', coordinatorOwner: 'alpha' } });
    assert.deepEqual([...pausableOf(config, 'app', IDS)], ['bravo']);
  });

  it('may pause a session of the team that shares its id with the coordinator owner of a team above', () => {
    const config = testConfig({ budget: { pauseByPriority: true }, roles: { lead: 'lead', coordinatorOwner: 'root/alpha' } });
    assert.deepEqual([...pausableOf(config, 'app', IDS)], ['alpha', 'bravo']);
  });

  it('keeps only the lead on a team with no coordinator owner', () => {
    assert.deepEqual([...pausableOf(testConfig({ budget: { pauseByPriority: true } }), 'app', IDS)], ['alpha', 'bravo']);
  });
});
