import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { loginRetryPrompt, loginRetryToast } from './login-retry.ts';

const COLD = { w: 210_000, cold: true, weekPct: 0.021 };
const FAIL_AT = Date.parse('2030-01-08T06:00:00.000Z');

describe('login retry prompt', () => {
  it('tells the tab when its turn failed, that the login works again, how to go on, and the cost', () => {
    assert.equal(
      loginRetryPrompt('alpha', FAIL_AT, 'recovered', COLD, TimeZone.UTC),
      'Your last turn ended on Login expired at 06:00 UTC; the login works again. ' +
        "Go on with that turn's work (if a wake started it: `teamrig start --session alpha`). " +
        'This retry costs at least about 210k W for the first call, cold, 0.02% of the week; whole turns usually cost more.',
    );
  });

  it("names a renewed login for a probe, and the failure on the team's clock", () => {
    assert.match(loginRetryPrompt('alpha', FAIL_AT, 'probe', COLD, JERUSALEM), /^Your last turn ended on Login expired at 08:00 IST; the login was renewed since\. /);
  });

  it('tells the person which sign retried the tab, and the cost', () => {
    assert.equal(loginRetryToast('recovered', COLD), "teamrig retried this tab's turn that ended on Login expired: the login works again (at least about 210k W for the first call, cold, 0.02% of the week; whole turns usually cost more)");
    assert.equal(loginRetryToast('probe', COLD), "teamrig retried this tab's turn that ended on Login expired: the login was renewed since (at least about 210k W for the first call, cold, 0.02% of the week; whole turns usually cost more)");
  });
});
