import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResetStock } from '../config/types.ts';
import { TimeZone } from '../core/zone.ts';
import { daysToExpiry, resetStockLines, resetSummaryLine, resetsLeft } from './resets.ts';

const NOW = Date.parse('2030-01-01T12:00:00Z');

const FABLE: ResetStock = { kind: 'fable', count: 3, expiresUtc: '2030-03-01 08:00', usedUtc: [] };
const BARE_FULL: ResetStock = { kind: 'full', count: 1, expiresUtc: '2030-01-02 22:00', usedUtc: [] };
const FULL: ResetStock = { ...BARE_FULL, note: 'saved for a busy week' };

describe('resetsLeft', () => {
  it('takes the uses from the count', () => {
    assert.equal(resetsLeft({ ...FABLE, usedUtc: ['2029-12-20 10:00'] }), 2);
  });

  it('never goes below 0 when more uses were logged than granted', () => {
    assert.equal(resetsLeft({ ...FULL, usedUtc: ['2029-12-20 10:00', '2029-12-21 10:00'] }), 0);
  });
});

describe('daysToExpiry', () => {
  it('counts whole days to the expiry, rounded down', () => {
    assert.equal(daysToExpiry(FABLE, NOW), 58);
  });

  it('is undefined for an expiry that does not parse', () => {
    assert.equal(daysToExpiry({ ...FABLE, expiresUtc: 'soon' }, NOW), undefined);
  });
});

describe('resetStockLines', () => {
  it('prints nothing when the account lists no grants', () => {
    assert.deepEqual(resetStockLines([], NOW, TimeZone.UTC), []);
  });

  it('lists each grant with what is left, its expiry on the team clock and its note', () => {
    assert.deepEqual(resetStockLines([FABLE, FULL], NOW, TimeZone.UTC), [
      'Resets in stock:',
      '  fable: 3 of 3 left, expire 2030-03-01 08:00 UTC (in 58 days)',
      '  full: 1 of 1 left, expire 2030-01-02 22:00 UTC (in 1 day) — saved for a busy week',
    ]);
  });

  it('marks a grant past its expiry as expired', () => {
    assert.deepEqual(resetStockLines([{ ...BARE_FULL, expiresUtc: '2029-12-31 22:00' }], NOW, TimeZone.UTC), [
      'Resets in stock:',
      '  full: 1 of 1 left, expired 2029-12-31 22:00 UTC',
    ]);
  });

  it('shows a grant used up as 0 left', () => {
    assert.deepEqual(resetStockLines([{ ...BARE_FULL, usedUtc: ['2029-12-30 10:00'] }], NOW, TimeZone.UTC), [
      'Resets in stock:',
      '  full: 0 of 1 left, expire 2030-01-02 22:00 UTC (in 1 day)',
    ]);
  });

  it('names an expiry it cannot read instead of guessing one', () => {
    assert.deepEqual(resetStockLines([{ ...FABLE, expiresUtc: 'soon' }], NOW, TimeZone.UTC), [
      'Resets in stock:',
      '  fable: 3 of 3 left, expiry unreadable (soon)',
    ]);
  });
});

describe('resetSummaryLine', () => {
  it('says nothing when the account lists no grants', () => {
    assert.equal(resetSummaryLine([], NOW, TimeZone.UTC, 'teamrig'), undefined);
  });

  it('sums the uses left per kind with the soonest expiry, in the order the config lists the kinds (T2450)', () => {
    const laterFable: ResetStock = { ...FABLE, count: 2, expiresUtc: '2030-06-01 08:00', usedUtc: ['2029-12-20 10:00'] };
    assert.equal(
      resetSummaryLine([laterFable, FULL, FABLE], NOW, TimeZone.UTC, 'teamrig'),
      'Resets in stock: fable 4 left, the next expiring 2030-03-01 08:00 UTC (in 58 days); full 1 left, the next expiring 2030-01-02 22:00 UTC (in 1 day).',
    );
  });

  it('leaves out grants used up, expired or with an expiry it cannot read', () => {
    const usedUp: ResetStock = { ...FABLE, count: 1, expiresUtc: '2030-01-05 08:00', usedUtc: ['2029-12-20 10:00'] };
    const expired: ResetStock = { ...FABLE, expiresUtc: '2029-12-31 08:00' };
    const unreadable: ResetStock = { ...FABLE, expiresUtc: 'soon' };
    assert.equal(
      resetSummaryLine([usedUp, expired, unreadable, FABLE], NOW, TimeZone.UTC, 'teamrig'),
      'Resets in stock: fable 3 left, the next expiring 2030-03-01 08:00 UTC (in 58 days).',
    );
  });

  it('says none are left, and where the grants are listed, when every grant is used up or expired', () => {
    assert.equal(
      resetSummaryLine([{ ...BARE_FULL, usedUtc: ['2029-12-30 10:00'] }, { ...FABLE, expiresUtc: '2029-12-31 08:00' }], NOW, TimeZone.UTC, 'teamrig'),
      'Resets in stock: none left (`teamrig budget` lists the grants).',
    );
  });
});
