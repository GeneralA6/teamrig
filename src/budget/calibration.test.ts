import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError, toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_WEEK } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  ACCOUNT_SCOPE,
  accountReadings,
  calibrationOf,
  crossingOf,
  FIT_SPREAD_PTS,
  fitRate,
  FRESH_READING_MS,
  METER_LOG_FORMAT,
  MeterLog,
  meterRecordOf,
  MOVED_RATE_DOWN,
  MOVED_RATE_MIN_PCT,
  MOVED_RATE_UP,
  parseMeterRecord,
  periodForecasts,
  READINGS_KEPT_MS,
  useAtW,
  type LoggedReading,
  type MeterReading,
  type RateFit,
  type ReadingSight,
} from './calibration.ts';
import type { Period, PeriodKind } from './period.ts';

const LOG = '/team/state/usage/meter-log.jsonl';
/** The week from Wednesday 10-21 01:00 to Wednesday 10-28 01:00, read on Thursday 10-22 at 12:00 UTC. */
const START = Date.parse('2026-10-21T01:00:00Z');
const END = Date.parse('2026-10-28T01:00:00Z');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const PERIOD: Period = { start: START, end: END, kind: 'week', lastPct: 12, lastAt: NOW - 5 * MS_PER_MINUTE };
/** The status line read 13% a minute ago, with 120M W metered since the week's start. */
const SIGHT: ReadingSight = {
  before: PERIOD,
  period: { ...PERIOD, lastPct: 13, lastAt: NOW - MS_PER_MINUTE },
  use: { usedPct: 13, resetsAt: END, at: NOW - MS_PER_MINUTE },
  covered: true,
  w: 120_000_000,
  now: NOW,
};
const FIT: RateFit = { wPerPct: 10_000_000, errorPts: 0.5, readings: 20 };

function reading(usedPct: number, w: number, overrides: Partial<MeterReading> = {}): MeterReading {
  return { at: NOW, usedPct, start: START, end: END, w, forecastPct: undefined, ...overrides };
}

/** A line of `team`'s, whose stores metered `w`. */
function teamLine(team: string, usedPct: number, w: number, overrides: Partial<MeterReading> = {}): LoggedReading {
  return { ...reading(usedPct, w, overrides), team };
}

/** An account line, whose `w` every team's stores on the account metered. */
function accountLine(usedPct: number, w: number, overrides: Partial<MeterReading> = {}): LoggedReading {
  return { ...reading(usedPct, w, overrides), scope: ACCOUNT_SCOPE };
}

describe('crossingOf', () => {
  it('logs the use the moment it passes a whole percent, with the W metered and the fit forecast for it', () => {
    assert.deepEqual(crossingOf(SIGHT, FIT), { at: NOW - MS_PER_MINUTE, usedPct: 13, start: START, end: END, w: 120_000_000, forecastPct: 12 });
    assert.equal(crossingOf(SIGHT, undefined)?.forecastPct, undefined);
  });

  it('logs nothing for the first reading of a period: its use may sit anywhere within its percent', () => {
    const opened: Period = { ...PERIOD, start: START + MS_PER_HOUR };
    assert.equal(crossingOf({ ...SIGHT, period: { ...opened, lastPct: 13 } }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, before: undefined }, FIT), undefined);
  });

  it('logs nothing while the use stays within its percent, or for a reading older than the last', () => {
    assert.equal(crossingOf({ ...SIGHT, before: { ...PERIOD, lastPct: 13 } }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, before: { ...PERIOD, lastPct: 12.2 }, use: { usedPct: 12.9, resetsAt: END, at: NOW - MS_PER_MINUTE } }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, before: { ...PERIOD, lastAt: NOW } }, FIT), undefined);
  });

  it('logs nothing for a reading the period left out, as old use a session showed late (T2019)', () => {
    const left: Period = { ...PERIOD, kind: 'reset', lastPct: 0 };
    const use = { usedPct: 29, resetsAt: END, at: NOW - MS_PER_MINUTE, after: PERIOD.lastAt - MS_PER_HOUR };
    assert.equal(crossingOf({ ...SIGHT, before: left, period: left, use }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, before: left, period: { ...left, lastPct: 29, lastAt: use.at }, use }, FIT)?.usedPct, 29);
  });

  it('logs nothing in a period with a guessed start, which would teach the fit its own guess', () => {
    const guessed: readonly PeriodKind[] = ['assumed', 'inferred'];
    for (const kind of guessed) {
      assert.equal(crossingOf({ ...SIGHT, before: { ...PERIOD, kind }, period: { ...PERIOD, kind, lastPct: 13 } }, FIT), undefined);
    }
    const reset: Period = { ...PERIOD, kind: 'reset' };
    assert.equal(crossingOf({ ...SIGHT, before: reset, period: { ...reset, lastPct: 13 } }, FIT)?.usedPct, 13);
  });

  it('logs nothing for a stale reading, one over 100%, one with no use, or before the stores reach the start', () => {
    const at = NOW - FRESH_READING_MS - 1;
    assert.equal(crossingOf({ ...SIGHT, before: { ...PERIOD, lastAt: at - MS_PER_MINUTE }, use: { usedPct: 13, resetsAt: END, at } }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, before: { ...PERIOD, lastPct: 100 }, use: { usedPct: 101, resetsAt: END, at: NOW } }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, use: undefined }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, period: undefined }, FIT), undefined);
    assert.equal(crossingOf({ ...SIGHT, covered: false }, FIT), undefined);
  });
});

describe('fitRate', () => {
  it('finds the W per percent of readings that sit on it, with no error', () => {
    const readings = [1, 5, 11].map((pct) => reading(pct, pct * 9_000_000));
    assert.deepEqual(fitRate(readings), { wPerPct: 9_000_000, errorPts: 0, readings: 3 });
  });

  it('fits through 0 by least squares and gives the misses in points', () => {
    // W on the use: (10*100 + 20*300) / (10^2 + 20^2) = 14 W per percent; the misses are 100/14 - 10 and 300/14 - 20.
    const fit = fitRate([reading(10, 100), reading(20, 300)]);
    assert.equal(fit?.wPerPct, 14);
    assert.equal(fit?.readings, 2);
    assert.equal(Math.round((fit?.errorPts ?? 0) * 1000) / 1000, Math.round(Math.sqrt(((100 / 14 - 10) ** 2 + (300 / 14 - 20) ** 2) / 2) * 1000) / 1000);
  });

  it(`fits nothing until the readings span ${FIT_SPREAD_PTS} points, or with no W`, () => {
    assert.equal(fitRate([]), undefined);
    assert.equal(fitRate([reading(1, 10), reading(1 + FIT_SPREAD_PTS - 1, 100)]), undefined);
    assert.notEqual(fitRate([reading(1, 10), reading(1 + FIT_SPREAD_PTS, 110)]), undefined);
    assert.equal(fitRate([reading(1, 0), reading(20, 0)]), undefined);
  });

  describe('across periods (T1985)', () => {
    const lastWeek = { start: START - MS_PER_WEEK, end: START };
    const atOldLimit = [10, 50, 94].map((pct) => reading(pct, pct * 9_000_000, lastWeek));

    it(`fits the newest period alone once it spans ${FIT_SPREAD_PTS} points, so a limit moved at the reset stops counting`, () => {
      const atNewLimit = [1, 6, 1 + FIT_SPREAD_PTS].map((pct) => reading(pct, pct * 4_000_000));
      assert.deepEqual(fitRate([...atOldLimit, ...atNewLimit]), { wPerPct: 4_000_000, errorPts: 0, readings: 3 });
    });

    it('keeps the last period that spans the points while the newest does not yet and agrees with it', () => {
      const started = [1, FIT_SPREAD_PTS].map((pct) => reading(pct, pct * 8_000_000));
      assert.deepEqual(fitRate([...atOldLimit, ...started]), { wPerPct: 9_000_000, errorPts: 0, readings: 3 });
    });

    describe('a limit moved, before the newest period spans the points (T2019)', () => {
      const ownAt = (wPerPct: number): readonly MeterReading[] => [1, MOVED_RATE_MIN_PCT].map((pct) => reading(pct, pct * wPerPct));
      const OLD_RATE = 9_000_000;

      it(`takes the newest period's own rate at ${MOVED_RATE_UP}x the older fit or over`, () => {
        const own = OLD_RATE * MOVED_RATE_UP;
        assert.deepEqual(fitRate([...atOldLimit, ...ownAt(own)]), { wPerPct: own, errorPts: 0, readings: 2 });
      });

      it(`takes the newest period's own rate at ${MOVED_RATE_DOWN}x the older fit or under`, () => {
        const own = OLD_RATE * MOVED_RATE_DOWN;
        assert.deepEqual(fitRate([...atOldLimit, ...ownAt(own)]), { wPerPct: own, errorPts: 0, readings: 2 });
      });

      it('keeps the older fit for a rate inside the two, the low read an early rate gives included', () => {
        for (const own of [OLD_RATE * 0.61, OLD_RATE * 1.18]) {
          assert.equal(fitRate([...atOldLimit, ...ownAt(own)])?.wPerPct, OLD_RATE);
        }
      });

      it(`keeps the older fit until the newest period reads ${MOVED_RATE_MIN_PCT}%: a first reading alone is noise`, () => {
        assert.equal(fitRate([...atOldLimit, reading(1, OLD_RATE * 3)])?.wPerPct, OLD_RATE);
      });

      it('keeps the older fit for a newest period with no W yet', () => {
        assert.equal(fitRate([...atOldLimit, reading(1, 0), reading(MOVED_RATE_MIN_PCT, 0)])?.wPerPct, OLD_RATE);
      });
    });

    it('fits all the readings of a team too quiet for any period to span the points alone', () => {
      const quiet = [reading(1, 9_000_000, lastWeek), reading(FIT_SPREAD_PTS, FIT_SPREAD_PTS * 9_000_000, lastWeek), reading(12, 12 * 9_000_000)];
      assert.deepEqual(fitRate(quiet), { wPerPct: 9_000_000, errorPts: 0, readings: 3 });
    });

    describe('readings whose W stood still (T2102)', () => {
      /** What `wSince` leaves of a day whose W all fell before the period's start hour. */
      const FLOAT_REMAINDER = 8.381903171539307e-9;
      const stoodStillAt = (w: number): readonly MeterReading[] => [1, 5, 11, 24].map((pct) => reading(pct, w));

      it('learns no rate from a team whose stores stood still while the account used the points', () => {
        assert.equal(fitRate(stoodStillAt(FLOAT_REMAINDER)), undefined);
        assert.equal(fitRate(stoodStillAt(1_000)), undefined);
      });

      it('keeps the older fit over a newest period that stood still, on a float remainder or a real W', () => {
        for (const w of [FLOAT_REMAINDER, 1_000]) {
          assert.equal(fitRate([...atOldLimit, ...stoodStillAt(w)])?.wPerPct, 9_000_000);
        }
      });

      it('keeps the older fit over a lone remainder past the points a moved rate needs', () => {
        assert.equal(fitRate([...atOldLimit, reading(29, FLOAT_REMAINDER)])?.wPerPct, 9_000_000);
      });

      it('fits the readings that rose, leaving out the ones a stalled store repeated', () => {
        assert.deepEqual(fitRate([reading(1, 9_000_000), reading(5, 9_000_000), reading(12, 108_000_000)]), { wPerPct: 9_000_000, errorPts: 0, readings: 2 });
      });
    });
  });
});

describe('periodForecasts', () => {
  it("gives each period's forecast misses, oldest first, leaving out readings no fit forecast", () => {
    const earlier = START - MS_PER_WEEK;
    const forecasts = periodForecasts([
      reading(13, 1, { forecastPct: 12 }),
      reading(14, 1, { forecastPct: 15 }),
      reading(30, 1, { start: earlier, end: START, forecastPct: 33 }),
      reading(31, 1),
    ]);
    assert.deepEqual(forecasts, [
      { start: earlier, errorPts: 3, readings: 1 },
      { start: START, errorPts: 1, readings: 2 },
    ]);
  });

  it('pairs the fit with the forecasts', () => {
    const readings = [reading(1, 10, { forecastPct: 2 }), reading(11, 110)];
    assert.deepEqual(calibrationOf(readings), { fit: fitRate(readings), periods: periodForecasts(readings) });
  });
});

describe('useAtW', () => {
  const RATE = 10_000_000;
  /** 46% at 460M W and 47% at 480M W: 20M W made the 47th percent, twice the fitted rate. */
  const READINGS = [reading(47, 480_000_000), reading(46, 460_000_000)];

  it('reads a W between two readings on the line through them, not at the fitted rate', () => {
    assert.equal(useAtW(READINGS, START, 470_000_000, RATE), 46.5);
    assert.equal(useAtW(READINGS, START, 460_000_000, RATE), 46);
  });

  it('reads a W past the last reading as that reading plus the W since it at the rate', () => {
    assert.equal(useAtW(READINGS, START, 485_000_000, RATE), 47.5);
  });

  it("reads a W before the first reading on the line from the period's start, 0% at 0 W", () => {
    assert.equal(useAtW(READINGS, START, 230_000_000, RATE), 23);
    assert.equal(useAtW([], START, 30_000_000, RATE), 3);
    assert.equal(useAtW(READINGS, START, -1, RATE), 0);
  });

  it("leaves out another period's readings", () => {
    const earlier = reading(80, 470_000_000, { start: START - MS_PER_WEEK, end: START });
    assert.equal(useAtW([...READINGS, earlier], START, 470_000_000, RATE), 46.5);
  });
});

describe('meter log records', () => {
  it('round-trips a reading, with and without a forecast, a team or the account scope', () => {
    for (const each of [reading(13, 120_000_000, { forecastPct: 12.5 }), reading(13, 120_000_000), teamLine('app', 13, 120_000_000), accountLine(13, 120_000_000)]) {
      assert.deepEqual(parseMeterRecord(meterRecordOf(each)), each);
    }
    assert.deepEqual(meterRecordOf(reading(13, 5)), { v: METER_LOG_FORMAT, at: '2026-10-22T12:00:00.000Z', usedPct: 13, start: '2026-10-21T01:00:00.000Z', end: '2026-10-28T01:00:00.000Z', w: 5 });
    assert.equal(meterRecordOf(teamLine('app', 13, 5))['team'], 'app');
    assert.equal(meterRecordOf(accountLine(13, 5))['scope'], 'account');
  });

  it('reads a damaged record, an unknown scope or a line on two scales as nothing', () => {
    const good = meterRecordOf(reading(13, 5));
    const damages = [{ at: 'soon' }, { usedPct: 0 }, { usedPct: '13' }, { w: -1 }, { end: '2026-10-20T01:00:00.000Z' }, { start: 7 }, { forecastPct: 'x' }, { team: '' }, { team: 7 }];
    const scopes = [{ scope: 'team' }, { scope: '' }, { scope: 7 }, { scope: 'account', team: 'app' }];
    for (const damage of [...damages, ...scopes]) {
      assert.equal(parseMeterRecord({ ...good, ...damage }), undefined, JSON.stringify(damage));
    }
  });
});

describe('accountReadings', () => {
  const LAST = { start: START - MS_PER_WEEK, end: START };
  const HOUR_AGO = { at: NOW - MS_PER_HOUR };

  it('takes the account lines and drops every team line logged after the first of them, the keeper\'s too', () => {
    // A tab still on an older teamrig logs its own team's W, for the keeper and for another team alike.
    const logged = [accountLine(13, 100, HOUR_AGO), teamLine('root', 14, 60), teamLine('app', 14, 40), accountLine(14, 108)];
    assert.deepEqual(accountReadings(logged, 'root'), [accountLine(13, 100, HOUR_AGO), accountLine(14, 108)]);
  });

  it("bridges a period with the keeper's own lines before its first account line, never another team's", () => {
    const logged = [
      teamLine('root', 40, 400, LAST),
      teamLine('app', 40, 300, LAST),
      teamLine('root', 12, 90, { at: NOW - 2 * MS_PER_HOUR }),
      teamLine('app', 12, 50, { at: NOW - 2 * MS_PER_HOUR }),
      accountLine(13, 100, HOUR_AGO),
    ];
    const expected = [teamLine('root', 40, 400, LAST), teamLine('root', 12, 90, { at: NOW - 2 * MS_PER_HOUR }), accountLine(13, 100, HOUR_AGO)];
    assert.deepEqual(accountReadings(logged, 'root'), expected);
    assert.deepEqual(accountReadings(logged, 'app'), [teamLine('app', 40, 300, LAST), teamLine('app', 12, 50, { at: NOW - 2 * MS_PER_HOUR }), accountLine(13, 100, HOUR_AGO)]);
  });

  it('counts a line naming no scale only in a period with no line naming one', () => {
    // Last week's lines name none. This week's untagged ones were logged by the teams in turn, each on its own scale.
    const logged = [reading(40, 400, LAST), reading(50, 500, LAST), reading(12, 130), reading(13, 120), accountLine(14, 130)];
    assert.deepEqual(accountReadings(logged, 'root'), [reading(40, 400, LAST), reading(50, 500, LAST), accountLine(14, 130)]);
  });
});

describe('MeterLog', () => {
  it('appends readings and reads them back, oldest first', async () => {
    const log = new MeterLog(new MemoryFiles(), LOG);
    await log.append(reading(13, 5), NOW);
    await log.append(reading(14, 6, { forecastPct: 14.2 }), NOW);
    assert.deepEqual(await log.read(NOW), [reading(13, 5), reading(14, 6, { forecastPct: 14.2 })]);
  });

  it('reads one line per percent of a period, the first, when two readers logged at once', async () => {
    const log = new MeterLog(new MemoryFiles(), LOG);
    await log.append(reading(13, 5), NOW);
    await log.append(reading(13.4, 7), NOW);
    await log.append(reading(13, 9, { start: START - MS_PER_WEEK, end: START }), NOW);
    assert.deepEqual(await log.read(NOW), [reading(13, 5), reading(13, 9, { start: START - MS_PER_WEEK, end: START })]);
  });

  it("reads each scale's line for a percent, and one per scale when two of its readers logged at once", async () => {
    const log = new MeterLog(new MemoryFiles(), LOG);
    await log.appendAll([teamLine('root', 13, 5), teamLine('app', 13, 6), accountLine(13, 11)], NOW);
    await log.appendAll([teamLine('app', 13.2, 7), accountLine(13.2, 15), teamLine('root', 13.2, 8)], NOW);
    assert.deepEqual(await log.read(NOW), [teamLine('root', 13, 5), teamLine('app', 13, 6), accountLine(13, 11)]);
  });

  it('appends several lines in one write, and writes nothing for none, even beside a newer line', async () => {
    const files = new MemoryFiles();
    const log = new MeterLog(files, LOG);
    await log.appendAll([teamLine('root', 13, 5), teamLine('app', 13, 6)], NOW);
    assert.equal(await files.read(LOG), `${toJsonlLine(meterRecordOf(teamLine('root', 13, 5)))}${toJsonlLine(meterRecordOf(teamLine('app', 13, 6)))}`);
    const newer = toJsonlLine({ ...meterRecordOf(reading(50, 1)), v: METER_LOG_FORMAT + 1 });
    await files.write(LOG, newer);
    await log.appendAll([], NOW);
    assert.equal(await files.read(LOG), newer);
  });

  it(`counts only the readings of the last ${READINGS_KEPT_MS / MS_PER_WEEK} weeks, and skips damaged lines and newer formats`, async () => {
    const files = new MemoryFiles();
    const old = reading(40, 1, { at: NOW - READINGS_KEPT_MS - 1 });
    await files.write(LOG, `${toJsonlLine(meterRecordOf(old))}not json\n${toJsonlLine({ ...meterRecordOf(reading(50, 1)), v: METER_LOG_FORMAT + 1 })}`);
    assert.deepEqual(await new MeterLog(files, LOG).read(NOW), []);
  });

  it('refuses to append beside a line from a newer teamrig', async () => {
    const files = new MemoryFiles();
    await files.write(LOG, toJsonlLine({ ...meterRecordOf(reading(50, 1)), v: METER_LOG_FORMAT + 1 }));
    await assert.rejects(new MeterLog(files, LOG).append(reading(13, 5), NOW), NewerDataError);
  });

  it('ends a torn last line before appending', async () => {
    const files = new MemoryFiles();
    await files.write(LOG, toJsonlLine(meterRecordOf(reading(12, 4))).trimEnd());
    const log = new MeterLog(files, LOG);
    await log.append(reading(13, 5), NOW);
    assert.deepEqual(await log.read(NOW), [reading(12, 4), reading(13, 5)]);
  });

  it('drops the lines no longer kept once one is a week past them, keeping the rest as written', async () => {
    const files = new MemoryFiles();
    const kept = toJsonlLine(meterRecordOf(reading(30, 3, { at: NOW - READINGS_KEPT_MS + MS_PER_HOUR })));
    const lapsed = toJsonlLine(meterRecordOf(reading(20, 2, { at: NOW - READINGS_KEPT_MS - MS_PER_HOUR })));
    const gone = toJsonlLine(meterRecordOf(reading(10, 1, { at: NOW - READINGS_KEPT_MS - MS_PER_WEEK - MS_PER_HOUR })));
    await files.write(LOG, `${lapsed}${kept}`);
    await new MeterLog(files, LOG).append(reading(13, 5), NOW);
    // No line is a week past the kept span yet: the lapsed one stays until one is.
    assert.equal(await files.read(LOG), `${lapsed}${kept}${toJsonlLine(meterRecordOf(reading(13, 5)))}`);
    await files.write(LOG, `${gone}${lapsed}${kept}`);
    await new MeterLog(files, LOG).append(reading(13, 5), NOW);
    assert.equal(await files.read(LOG), `${kept}${toJsonlLine(meterRecordOf(reading(13, 5)))}`);
  });
});
