import { MS_PER_DAY, parseUtcDeadline } from "../core/time.js";
/** How many uses of a grant are left: its count less the uses taken, never below 0. */
export function resetsLeft(stock) {
    return Math.max(0, stock.count - stock.usedUtc.length);
}
/** Whole days from `now` to the grant's expiry, rounded down; undefined when its expiry does not parse. */
export function daysToExpiry(stock, now) {
    const expires = parseUtcDeadline(stock.expiresUtc);
    return expires === undefined ? undefined : Math.floor((expires.getTime() - now) / MS_PER_DAY);
}
function stockLine(stock, now, zone) {
    const left = `${resetsLeft(stock)} of ${stock.count} left`;
    const expires = parseUtcDeadline(stock.expiresUtc);
    const days = daysToExpiry(stock, now);
    const when = expires === undefined || days === undefined
        ? `expiry unreadable (${stock.expiresUtc})`
        : expires.getTime() <= now
            ? `expired ${zone.minute(expires)}`
            : `expire ${zone.minute(expires)} (in ${days} day${days === 1 ? '' : 's'})`;
    const note = stock.note === undefined ? '' : ` — ${stock.note}`;
    return `  ${stock.kind}: ${left}, ${when}${note}`;
}
/** The grants with uses left and an expiry still ahead, summed per kind in the order the config lists them. */
function liveStockByKind(resets, now) {
    const byKind = new Map();
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
export function resetSummaryLine(resets, now, zone, command) {
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
export function resetStockLines(resets, now, zone) {
    return resets.length === 0 ? [] : ['Resets in stock:', ...resets.map((stock) => stockLine(stock, now, zone))];
}
