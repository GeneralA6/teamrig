import type { Files } from '../core/files.ts';
import type { TimeZone } from '../core/zone.ts';
import { isLate, lateGroupText, newestLate, parseClocks } from '../github/clock.ts';
import type { UnownedWarning } from './unowned.ts';

/**
 * GH-LATE (T3028, design T3021 section 4), for `check`: the GitHub threads that waited past their answer target for
 * an answer of ours. Each owner was reminded at 75% (src/cli/commands/issue-clock.ts); past 100% they are the lead's
 * to chase. Reads the clocks the last writing sync kept, so it costs no GitHub call. One warning for them all, with
 * their count and the oldest few (#1475), so many late threads never flood the lead. Its key names the wait whose
 * target passed last: the lead is told once, and again only when a newer wait goes late (a fresh wait after our
 * answer included), not when an older one is answered.
 */
export async function githubLateWarnings(files: Pick<Files, 'read'>, clocksFile: string, zone: TimeZone, now: number): Promise<UnownedWarning[]> {
  const late = [...parseClocks((await files.read(clocksFile)) ?? '').values()].filter((clock) => isLate(clock, now));
  const newest = newestLate(late);
  return newest === undefined ? [] : [{ key: `gh-late ${newest.ref} ${newest.since}`, source: 'the response clock [github]', text: lateGroupText(late, now, zone) }];
}
