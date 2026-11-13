/**
 * The account's reset grants (`budget.resets`) as lines under the budget table: how many of each are left and when
 * they expire, so a grant is used before it lapses instead of being forgotten in a mail.
 */
import type { ResetStock } from '../config/types.ts';
import { MS_PER_DAY, parseUtcDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';

/** How many uses of a grant are left: its count less the uses taken, never below 0. */
export function resetsLeft(stock: ResetStock): number {
  return Math.max(0, stock.count - stock.usedUtc.length);
}

/** Whole days from `now` to the grant's expiry, rounded down; undefined when its expiry does not parse. */
export function daysToExpiry(stock: ResetStock, now: number): number | undefined {
  const expires = parseUtcDeadline(stock.expiresUtc);
  return expires === undefined ? undefined : Math.floor((expires.getTime() - now) / MS_PER_DAY);
}

function stockLine(stock: ResetStock, now: number, zone: TimeZone): string {
  const left = `${resetsLeft(stock)} of ${stock.count} left`;
  const expires = parseUtcDeadline(stock.expiresUtc);
  const days = daysToExpiry(stock, now);
  const when =
    expires === undefined || days === undefined
      ? `expiry unreadable (${stock.expiresUtc})`
      : expires.getTime() <= now
        ? `expired ${zone.minute(expires)}`
        : `expire ${zone.minute(expires)} (in ${days} day${days === 1 ? '' : 's'})`;
  const note = stock.note === undefined ? '' : ` — ${stock.note}`;
  return `  ${stock.kind}: ${left}, ${when}${note}`;
}

/** The "Resets in stock" block of the budget view; no lines when the account lists no grants. */
export function resetStockLines(resets: readonly ResetStock[], now: number, zone: TimeZone): string[] {
  return resets.length === 0 ? [] : ['Resets in stock:', ...resets.map((stock) => stockLine(stock, now, zone))];
}
