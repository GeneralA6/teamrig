import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { FIVE_HOUR_RATE_SPAN_MS, fiveHourForecast, fiveHourLine } from './five-hour-forecast.ts';
import type { FiveHourFold } from './five-hour-summary.ts';

const RESETS_AT = Date.parse('2030-01-08T13:00:00Z');

/** A window that read 30% at 08:00 and 60% at 08:30: 60 points an hour, full at 09:10, long before its 13:00 reset. */
const RISING: FiveHourFold = {
  resetsAt: RESETS_AT,
  usedPct: 60,
  at: Date.parse('2030-01-08T08:30:00Z'),
  firstPct: 30,
  firstAt: Date.parse('2030-01-08T08:00:00Z'),
};
/** 10% at 09:00 and 12% at 10:00: 2 points an hour, 18% at the reset. */
const SLOW: FiveHourFold = {
  resetsAt: RESETS_AT,
  usedPct: 12,
  at: Date.parse('2030-01-08T10:00:00Z'),
  firstPct: 10,
  firstAt: Date.parse('2030-01-08T09:00:00Z'),
};

describe('fiveHourForecast', () => {
  it('reads the rate from the first reading to the highest and says when the window fills', () => {
    assert.deepEqual(fiveHourForecast(RISING), { ptsPerHour: 60, fullAt: Date.parse('2030-01-08T09:10:00Z'), endPct: 330 });
  });

  it('names no time when the window resets first', () => {
    assert.deepEqual(fiveHourForecast(SLOW), { ptsPerHour: 2, fullAt: undefined, endPct: 18 });
  });

  it('names no time for a window that reaches 100% only as it resets', () => {
    assert.deepEqual(fiveHourForecast({ ...SLOW, usedPct: 55, firstPct: 40 }), { ptsPerHour: 15, fullAt: undefined, endPct: 100 });
  });

  it('reads a window that stopped rising as ending where it stands', () => {
    assert.deepEqual(fiveHourForecast({ ...SLOW, firstPct: SLOW.usedPct }), { ptsPerHour: 0, fullAt: undefined, endPct: 12 });
  });

  it('forecasts nothing from readings under the span, and from the span on', () => {
    const at = RISING.firstAt + FIVE_HOUR_RATE_SPAN_MS;
    assert.equal(fiveHourForecast({ ...RISING, at: at - MS_PER_MINUTE }), undefined);
    assert.notEqual(fiveHourForecast({ ...RISING, at }), undefined);
  });

  it('forecasts nothing for a window already full', () => {
    assert.equal(fiveHourForecast({ ...RISING, usedPct: 100 }), undefined);
  });
});

describe('fiveHourLine', () => {
  it('says when a rising window fills', () => {
    assert.equal(
      fiveHourLine(RISING, TimeZone.UTC),
      'Five-hour window: 60.0% used at 08:30 UTC. Resets 13:00 UTC. At its rise of 60.0 points an hour, it reaches 100% 09:10 UTC.',
    );
  });

  it('says where a window that will not fill ends', () => {
    assert.equal(fiveHourLine(SLOW, TimeZone.UTC), 'Five-hour window: 12.0% used at 10:00 UTC. Resets 13:00 UTC. At its rise of 2.0 points an hour, it ends near 18%.');
  });

  it('gives only the use and the reset while there is no rate to read', () => {
    assert.equal(fiveHourLine({ ...SLOW, firstAt: SLOW.at }, TimeZone.UTC), 'Five-hour window: 12.0% used at 10:00 UTC. Resets 13:00 UTC.');
  });
});
