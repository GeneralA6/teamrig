/**
 * The account's reset grants (`budget.resets`) as lines under the budget table: how many of each are left and when
 * they expire, so a grant is used before it lapses instead of being forgotten in a mail. The person's other accounts
 * (kind `account`) show beside them: how many are free now and when the next one comes back.
 */
import type { ExpiringResetStock, ResetStock } from '../config/types.ts';
import { MS_PER_DAY, parseUtcDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';

/** An account switched to is free again a week later, when its own week has run (types.ts RESET_KINDS). */
export const ACCOUNT_BACK_MS = 7 * MS_PER_DAY;

/** When each use of an account stock that is still within its week ends, soonest first. */
function accountsBackAt(stock: ResetStock, now: number): number[] {
  return stock.usedUtc
    .map((used) => parseUtcDeadline(used))
    .flatMap((used) => (used === undefined ? [] : [used.getTime() + ACCOUNT_BACK_MS]))
    .filter((back) => back > now)
    .sort((a, b) => a - b);
}

/**
 * How many uses of a stock are left, never below 0: a grant's count less the uses taken; an account stock's count less
 * the switches of the last week.
 */
export function resetsLeft(stock: ResetStock, now: number): number {
  const used = stock.kind === 'account' ? accountsBackAt(stock, now).length : stock.usedUtc.length;
  return Math.max(0, stock.count - used);
}

/** Whole days from `now` to the grant's expiry, rounded down; undefined when its expiry does not parse. */
export function daysToExpiry(stock: ExpiringResetStock, now: number): number | undefined {
  const expires = parseUtcDeadline(stock.expiresUtc);
  return expires === undefined ? undefined : Math.floor((expires.getTime() - now) / MS_PER_DAY);
}

function inDays(at: number, now: number): string {
  const days = Math.floor((at - now) / MS_PER_DAY);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function grantWhen(stock: ExpiringResetStock, now: number, zone: TimeZone): string {
  const expires = parseUtcDeadline(stock.expiresUtc);
  if (expires === undefined) {
    return `expiry unreadable (${stock.expiresUtc})`;
  }
  return expires.getTime() <= now ? `expired ${zone.minute(expires)}` : `expire ${zone.minute(expires)} (${inDays(expires.getTime(), now)})`;
}

function accountWhen(stock: ResetStock, now: number, zone: TimeZone): string {
  const next = accountsBackAt(stock, now)[0];
  return next === undefined ? 'each back a week after its switch' : `the next back ${zone.minute(new Date(next))} (${inDays(next, now)})`;
}

function stockLine(stock: ResetStock, now: number, zone: TimeZone): string {
  const left = `${resetsLeft(stock, now)} of ${stock.count} left`;
  const when = stock.kind === 'account' ? accountWhen(stock, now, zone) : grantWhen(stock, now, zone);
  const note = stock.note === undefined ? '' : ` — ${stock.note}`;
  return `  ${stock.kind}: ${left}, ${when}${note}`;
}

/** A kind's uses left across its live stocks and the soonest of their expiries; an account stock has none. */
interface KindStock {
  readonly kind: ResetStock['kind'];
  readonly left: number;
  readonly nextExpiry: Date | undefined;
}

/** When a stock's uses lapse: a grant's expiry, undefined for an account stock; null when the stock is gone. */
function lapseOf(stock: ResetStock, now: number): Date | undefined | null {
  if (stock.kind === 'account') {
    return undefined;
  }
  const expires = parseUtcDeadline(stock.expiresUtc);
  return expires === undefined || expires.getTime() <= now ? null : expires;
}

function sooner(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }
  return a.getTime() <= b.getTime() ? a : b;
}

/** The stocks with uses left that have not lapsed, summed per kind in the order the config lists them. */
function liveStockByKind(resets: readonly ResetStock[], now: number): KindStock[] {
  const byKind = new Map<ResetStock['kind'], KindStock>();
  for (const stock of resets) {
    const left = resetsLeft(stock, now);
    const lapse = lapseOf(stock, now);
    if (left === 0 || lapse === null) {
      continue;
    }
    const seen = byKind.get(stock.kind);
    byKind.set(stock.kind, { kind: stock.kind, left: (seen?.left ?? 0) + left, nextExpiry: seen === undefined ? lapse : sooner(seen.nextExpiry, lapse) });
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
  const parts = kinds.map(({ kind, left, nextExpiry }) =>
    nextExpiry === undefined ? `${kind} ${left} left` : `${kind} ${left} left, the next expiring ${zone.minute(nextExpiry)} (${inDays(nextExpiry.getTime(), now)})`,
  );
  return `Resets in stock: ${parts.join('; ')}.`;
}

/** The "Resets in stock" block of the budget view; no lines when the account lists no grants. */
export function resetStockLines(resets: readonly ResetStock[], now: number, zone: TimeZone): string[] {
  return resets.length === 0 ? [] : ['Resets in stock:', ...resets.map((stock) => stockLine(stock, now, zone))];
}
