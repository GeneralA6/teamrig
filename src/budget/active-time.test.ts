import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { QuietHours } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import { DailyProfile } from './active-time.ts';

const NIGHT: QuietHours = { startUtc: '22:00', endUtc: '06:00', action: 'ask' };
const MIDDAY: QuietHours = { startUtc: '12:00', endUtc: '14:00', action: 'warn' };

function at(iso: string): number {
  return Date.parse(iso);
}

function hours(ms: number): number {
  return Math.round((ms / MS_PER_HOUR) * 1000) / 1000;
}

describe('DailyProfile', () => {
  it('counts clock time when even, and without quiet hours', () => {
    const from = at('2026-10-18T20:56:00Z');
    assert.equal(DailyProfile.even().activeMs(from, from + 3 * MS_PER_DAY), 3 * MS_PER_DAY);
    assert.equal(DailyProfile.ofQuietHours(undefined).activeMs(from, from + MS_PER_HOUR), MS_PER_HOUR);
  });

  it('counts nothing for an empty or backward span', () => {
    const from = at('2026-10-18T10:00:00Z');
    assert.equal(DailyProfile.even().activeMs(from, from), 0);
    assert.equal(DailyProfile.even().activeMs(from, from - MS_PER_HOUR), 0);
  });

  it('skips quiet hours that cross midnight', () => {
    const profile = DailyProfile.ofQuietHours(NIGHT);
    assert.equal(hours(profile.activeMs(at('2026-10-18T00:00:00Z'), at('2026-10-19T00:00:00Z'))), 16);
    assert.equal(hours(profile.activeMs(at('2026-10-18T21:00:00Z'), at('2026-10-19T07:00:00Z'))), 2);
    assert.equal(hours(profile.activeMs(at('2026-10-18T23:00:00Z'), at('2026-10-19T05:59:00Z'))), 0);
  });

  it('skips quiet hours inside the day', () => {
    const profile = DailyProfile.ofQuietHours(MIDDAY);
    assert.equal(hours(profile.activeMs(at('2026-10-18T11:00:00Z'), at('2026-10-18T15:00:00Z'))), 2);
    assert.equal(hours(profile.activeMs(at('2026-10-18T00:00:00Z'), at('2026-10-20T00:00:00Z'))), 44);
  });

  it('counts quiet minutes at their pace weight', () => {
    const profile = DailyProfile.ofQuietHours({ ...NIGHT, paceWeight: 0.25 });
    assert.equal(hours(profile.activeMs(at('2026-10-18T00:00:00Z'), at('2026-10-19T00:00:00Z'))), 16 + 8 * 0.25);
  });

  it('sums whole weeks the same as day by day', () => {
    const profile = DailyProfile.ofQuietHours(NIGHT);
    const start = at('2026-10-14T01:00:00Z');
    let byDay = 0;
    for (let day = 0; day < 7; day += 1) {
      byDay += profile.activeMs(start + day * MS_PER_DAY, start + (day + 1) * MS_PER_DAY);
    }
    assert.equal(profile.activeMs(start, start + 7 * MS_PER_DAY), byDay);
    assert.equal(hours(byDay), 7 * 16);
  });
});
