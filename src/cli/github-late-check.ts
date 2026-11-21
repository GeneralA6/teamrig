import type { Files } from '../core/files.ts';
import type { TimeZone } from '../core/zone.ts';
import { lateGroupText, leadTurnAt, newestLate, parseClocks, type Clock, type OwnerFirst } from '../github/clock.ts';
import { parseUnownedNotices, UNOWNED_SEEN_REFRESH_MS, type ToldWarnings } from './unowned-notices.ts';
import type { UnownedWarning } from './unowned.ts';

const KEY_WORD = 'gh-late';

/**
 * How recently a start must have seen a told GH-LATE standing for a later one to keep its key: twice the time a start
 * leaves a standing warning's seen time alone (UNOWNED_SEEN_REFRESH_MS), so a group that stood at the last starts
 * counts, and one whose threads were all answered hours ago does not.
 */
const STILL_STANDING_MS = 2 * UNOWNED_SEEN_REFRESH_MS;

/** A grouped GH-LATE's key: when the newest late wait came to the lead (its lead's turn), then its ref. */
function lateKey(due: number, ref: string): string {
  return `${KEY_WORD} ${new Date(due).toISOString()} ${ref}`;
}

/** The lead's turn a told GH-LATE key names; undefined for another warning's key or an older teamrig's form. */
function keyDue(key: string): number | undefined {
  const [word, due] = key.split(' ');
  const at = word === KEY_WORD && due !== undefined ? Date.parse(due) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** The told GH-LATE still standing at a recent start whose turn came last, if any. */
function toldHighWater(told: ToldWarnings, now: number): { key: string; due: number } | undefined {
  let best: { key: string; due: number } | undefined;
  for (const [key, seenAt] of told) {
    const due = keyDue(key);
    if (due !== undefined && seenAt !== undefined && now - seenAt < STILL_STANDING_MS && (best === undefined || due > best.due)) {
      best = { key, due };
    }
  }
  return best;
}

/**
 * GH-LATE (T3028, design T3021 section 4), for `check`: the GitHub threads that waited past their answer target for
 * an answer of ours. Each owner was reminded at 75% and, when told first, told GH-LATE at 100%
 * (src/cli/commands/issue-clock.ts); from the lead's turn (leadTurnAt, #1507) they are the lead's to chase. Reads the
 * clocks the last writing sync kept, so it costs no GitHub call. One warning for them all, with their count and the
 * oldest few (#1475), so many late threads never flood the lead. Its key only moves forward: it names the wait that
 * came to the lead last, unless a GH-LATE told and still standing names a later turn (its newest thread was answered
 * while others stay late), whose key it keeps. So the lead is told once, and again only when a newer wait comes to
 * it (a fresh wait after our answer included), not when any one is answered.
 */
export async function githubLateWarnings(
  files: Pick<Files, 'read'>,
  paths: { clocks: string; notices: string },
  zone: TimeZone,
  now: number,
  ownerFirst: OwnerFirst,
): Promise<UnownedWarning[]> {
  const turnAt = (clock: Clock): number => leadTurnAt(clock, ownerFirst);
  const late = [...parseClocks((await files.read(paths.clocks)) ?? '').values()].filter((clock) => now >= turnAt(clock));
  const newest = newestLate(late, turnAt);
  if (newest === undefined) {
    return [];
  }
  const told = toldHighWater(parseUnownedNotices((await files.read(paths.notices)) ?? '') ?? new Map(), now);
  const key = told !== undefined && told.due >= turnAt(newest) ? told.key : lateKey(turnAt(newest), newest.ref);
  return [{ key, source: 'the response clock [github]', text: lateGroupText(late, now, zone) }];
}
