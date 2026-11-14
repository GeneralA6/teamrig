import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { heldToday, policyReleaseOf, releaseLineOf } from './release.ts';
import { emptyWarnState } from './warn.ts';
import { WarnStore } from './warn-store.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const WARN = '/warn';

describe('policyReleaseOf', () => {
  it('frees held sessions when a holding budget turns off or warn only', () => {
    assert.equal(policyReleaseOf({ enabled: true, overAction: 'ask-lead' }, { enabled: false, overAction: 'ask-lead' }), 'off');
    assert.equal(policyReleaseOf({ enabled: true, overAction: 'block' }, { enabled: true, overAction: 'warn' }), 'warn');
  });

  it('frees none when the old budget held none, or the new one still holds', () => {
    assert.equal(policyReleaseOf({ enabled: false, overAction: 'ask' }, { enabled: true, overAction: 'warn' }), undefined);
    assert.equal(policyReleaseOf({ enabled: true, overAction: 'warn' }, { enabled: false, overAction: 'warn' }), undefined);
    assert.equal(policyReleaseOf({ enabled: true, overAction: 'ask-lead' }, { enabled: true, overAction: 'ask' }), undefined);
  });
});

describe('heldToday', () => {
  it("lists only the sessions held at today's last turn end, in the order asked", async () => {
    const store = new WarnStore(new MemoryFiles({}, new FakeClock('2030-01-08T10:00:00Z')), WARN);
    await store.write('alpha', { ...emptyWarnState('2030-01-08'), held: true });
    await store.write('bravo', { ...emptyWarnState('2030-01-08'), held: false });
    await store.write('charlie', { ...emptyWarnState('2030-01-07'), held: true });
    await store.write('delta', { ...emptyWarnState('2030-01-08'), held: true });
    assert.deepEqual(await heldToday(store, ['delta', 'alpha', 'bravo', 'charlie', 'echo'], NOW), ['delta', 'alpha']);
  });
});

describe('releaseLineOf', () => {
  it('names who freed the session and how', () => {
    assert.equal(releaseLineOf('lead', 'lifted your daily budget'), 'Budget: lead lifted your daily budget, so your budget hold is over: carry on with your task list.');
  });
});
