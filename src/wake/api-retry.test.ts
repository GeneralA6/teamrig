import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { apiRetryPrompt, apiRetryToast } from './api-retry.ts';

const COLD = { w: 210_000, cold: true, weekPct: 0.021 };
const RETRY = { code: 'server_error', failAt: Date.parse('2030-01-08T06:00:00.000Z'), n: 2 };

describe('API error retry prompt', () => {
  it('tells the tab the error, when its turn failed, which retry this is, how to go on, and the cost', () => {
    assert.equal(
      apiRetryPrompt('alpha', RETRY, COLD, TimeZone.UTC),
      'Your last turn ended on an API error (server_error) at 06:00 UTC; retry 2 of 3. ' +
        "Go on with that turn's work (if a wake started it: `teamrig start --session alpha`). " +
        'This retry costs at least about 210k W for the first call, cold, 0.02% of the week; whole turns usually cost more.',
    );
  });

  it("says the failure on the team's clock", () => {
    assert.match(apiRetryPrompt('alpha', { ...RETRY, code: 'overloaded' }, COLD, JERUSALEM), /^Your last turn ended on an API error \(overloaded\) at 08:00 IST; retry 2 of 3\. /);
  });

  it('tells the person which error retried the tab, which retry, and the cost', () => {
    assert.equal(apiRetryToast(RETRY, COLD), "teamrig retried this tab's turn that ended on an API error (server_error), 2 of 3 (at least about 210k W for the first call, cold, 0.02% of the week; whole turns usually cost more)");
  });
});
