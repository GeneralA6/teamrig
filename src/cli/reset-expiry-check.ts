import { daysToExpiry, resetsLeft } from '../budget/resets.ts';
import type { BudgetConfig } from '../config/types.ts';
import { parseUtcDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { UnownedWarning } from './unowned.ts';

/**
 * Two weekly resets ahead: enough for the lead to pick the week a grant is spent on, short enough that a grant months
 * from its expiry does not stand in every check.
 */
export const RESET_EXPIRY_WARN_DAYS = 14;

/**
 * RESET-EXPIRING (T2450), for `check`: a reset grant in `budget.resets` with uses left that expires within
 * RESET_EXPIRY_WARN_DAYS is lost if nobody spends it, a call no session owns, so it goes to the lead. Its key names the
 * grant and how many are left, so the lead is told once per grant and again after a use. An expired or unreadable
 * grant says nothing: `teamrig budget` shows it, and nothing can be done about it any more.
 */
export function resetExpiryWarnings(budget: Pick<BudgetConfig, 'enabled' | 'resets'>, zone: TimeZone, now: number): UnownedWarning[] {
  if (!budget.enabled) {
    return [];
  }
  return budget.resets.flatMap((stock) => {
    const left = resetsLeft(stock);
    const expires = parseUtcDeadline(stock.expiresUtc);
    const days = daysToExpiry(stock, now);
    if (left === 0 || expires === undefined || days === undefined || expires.getTime() <= now || days >= RESET_EXPIRY_WARN_DAYS) {
      return [];
    }
    const text = `RESET-EXPIRING ${stock.kind} resets: ${left} of ${stock.count} left, expiring ${zone.minute(expires)} (in ${days} day${days === 1 ? '' : 's'}); one not spent by then is lost`;
    return [{ key: `reset-expiring ${stock.kind} ${stock.expiresUtc} ${left}`, source: 'the reset expiry check [budget.resets]', text }];
  });
}
