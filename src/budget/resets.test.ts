import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountResetStock, ExpiringResetStock } from '../config/types.ts';
import { TimeZone } from '../core/zone.ts';
import { ACCOUNT_BACK_MS, daysToExpiry, resetStockLines, resetSummaryLine, resetsLeft } from './resets.ts';

const NOW = Date.parse('2030-01-01T12:00:00Z');

const FABLE: ExpiringResetStock = { kind: 'fable', count: 3, expiresUtc: '2030-03-01 08:00', usedUtc: [] };
const BARE_FULL: ExpiringResetStock = { kind: 'full', count: 1, expiresUtc: '2030-01-02 22:00', usedUtc: [] };
const FULL: ExpiringResetStock = { ...BARE_FULL, note: 'saved for a busy week' };
/** Two other accounts: one switched to 12 days ago (free again), one 2 days ago (back 2030-01-06 09:00 UTC). */
const ACCOUNTS: AccountResetStock = { kind: 'account', count: 2, usedUtc: ['2029-12-20 10:00', '2029-12-30 09:00'] };

function utcMinute(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

describe('resetsLeft', () => {
  it('takes the uses from the count', () => {
    assert.equal(resetsLeft({ ...FABLE, usedUtc: ['2029-12-20 10:00'] }, NOW), 2);
  });

  it('never goes below 0 when more uses were logged than granted', () => {
    assert.equal(resetsLeft({ ...FULL, usedUtc: ['2029-12-20 10:00', '2029-12-21 10:00'] }, NOW), 0);
  });

  it('counts an account free again once a week has passed since its switch (T939)', () => {
    assert.equal(resetsLeft(ACCOUNTS, NOW), 1);
    assert.equal(resetsLeft({ ...ACCOUNTS, usedUtc: [utcMinute(NOW - ACCOUNT_BACK_MS)] }, NOW), 2);
    assert.equal(resetsLeft({ ...ACCOUNTS, usedUtc: [utcMinute(NOW - ACCOUNT_BACK_MS + 60_000)] }, NOW), 1);
  });
});

describe('account stocks (T939)', () => {
  it('list how many accounts are free and when the next comes back, with no expiry', () => {
    assert.deepEqual(resetStockLines([ACCOUNTS, { ...ACCOUNTS, usedUtc: [], note: 'the second seat' }], NOW, TimeZone.UTC), [
      'Resets in stock:',
      '  account: 1 of 2 left, the next back 2030-01-06 09:00 UTC (in 4 days)',
      '  account: 2 of 2 left, each back a week after its switch — the second seat',
    ]);
  });

  it('sum into the summary line beside the grants, with no expiry named', () => {
    assert.equal(
      resetSummaryLine([FULL, ACCOUNTS], NOW, TimeZone.UTC, 'teamrig'),
      'Resets in stock: full 1 left, the next expiring 2030-01-02 22:00 UTC (in 1 day); account 1 left.',
    );
  });

  it('leave the summary when every account is within its week', () => {
    const allUsed: AccountResetStock = { ...ACCOUNTS, usedUtc: ['2029-12-31 10:00', '2029-12-30 09:00'] };
    assert.equal(resetSummaryLine([allUsed], NOW, TimeZone.UTC, 'teamrig'), 'Resets in stock: none left (`teamrig budget` lists the grants).');
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
    const laterFable: ExpiringResetStock = { ...FABLE, count: 2, expiresUtc: '2030-06-01 08:00', usedUtc: ['2029-12-20 10:00'] };
    assert.equal(
      resetSummaryLine([laterFable, FULL, FABLE], NOW, TimeZone.UTC, 'teamrig'),
      'Resets in stock: fable 4 left, the next expiring 2030-03-01 08:00 UTC (in 58 days); full 1 left, the next expiring 2030-01-02 22:00 UTC (in 1 day).',
    );
  });

  it('leaves out grants used up, expired or with an expiry it cannot read', () => {
    const usedUp: ExpiringResetStock = { ...FABLE, count: 1, expiresUtc: '2030-01-05 08:00', usedUtc: ['2029-12-20 10:00'] };
    const expired: ExpiringResetStock = { ...FABLE, expiresUtc: '2029-12-31 08:00' };
    const unreadable: ExpiringResetStock = { ...FABLE, expiresUtc: 'soon' };
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
