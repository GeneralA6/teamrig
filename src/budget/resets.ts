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

/** A kind's uses left across its live grants and the soonest of their expiries. */
interface KindStock {
  readonly kind: ResetStock['kind'];
  readonly left: number;
  readonly nextExpiry: Date;
}

/** The grants with uses left and an expiry still ahead, summed per kind in the order the config lists them. */
function liveStockByKind(resets: readonly ResetStock[], now: number): KindStock[] {
  const byKind = new Map<ResetStock['kind'], KindStock>();
  for (const stock of resets) {
    const left = resetsLeft(stock);
    const expires = parseUtcDeadline(stock.expiresUtc);
    if (left === 0 || expires === undefined || expires.getTime() <= now) {
      continue;
    }
    const seen = byKind.get(stock.kind);
    byKind.set(stock.kind, {
      kind: stock.kind,
      left: (seen?.left ?? 0) + left,
      nextExpiry: seen === undefined || expires.getTime() < seen.nextExpiry.getTime() ? expires : seen.nextExpiry,
    });
  }
  return [...byKind.values()];
}

/**
 * One line for the lead's start and meeting (T2450): the uses left per kind and the soonest expiry, so
 * the lead plans the week on them and asks the owner for a reset before one lapses; `budget` lists each grant.
 * Undefined when the account lists no grants.
 */
export function resetSummaryLine(resets: readonly ResetStock[], now: number, zone: TimeZone, command: string): string | undefined {
  if (resets.length === 0) {
    return undefined;
  }
  const kinds = liveStockByKind(resets, now);
  if (kinds.length === 0) {
    return `Resets in stock: none left (\`${command} budget\` lists the grants).`;
  }
  const parts = kinds.map(({ kind, left, nextExpiry }) => {
    const days = Math.floor((nextExpiry.getTime() - now) / MS_PER_DAY);
    return `${kind} ${left} left, the next expiring ${zone.minute(nextExpiry)} (in ${days} day${days === 1 ? '' : 's'})`;
  });
  return `Resets in stock: ${parts.join('; ')}.`;
}

/** The "Resets in stock" block of the budget view; no lines when the account lists no grants. */
export function resetStockLines(resets: readonly ResetStock[], now: number, zone: TimeZone): string[] {
  return resets.length === 0 ? [] : ['Resets in stock:', ...resets.map((stock) => stockLine(stock, now, zone))];
}
