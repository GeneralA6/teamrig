import type { Files } from '../core/files.ts';
import type { TimeZone } from '../core/zone.ts';
import { isLate, lateText, parseClocks } from '../github/clock.ts';
import type { UnownedWarning } from './unowned.ts';

/**
 * GH-LATE (T3028, design T3021 section 4), for `check`: a GitHub thread that waited past its answer target for an
 * answer of ours. Its owner was reminded at 75% (src/cli/commands/issue-clock.ts); past 100% it is the lead's to chase.
 * Reads the clocks the last writing sync kept, so it costs no GitHub call. Its key names the thread and the wait it
 * times: the lead is told once a wait, and again only for a fresh wait after our answer.
 */
export async function githubLateWarnings(files: Pick<Files, 'read'>, clocksFile: string, zone: TimeZone, now: number): Promise<UnownedWarning[]> {
  const clocks = parseClocks((await files.read(clocksFile)) ?? '');
  return [...clocks.values()]
    .filter((clock) => isLate(clock, now))
    .map((clock) => ({ key: `gh-late ${clock.ref} ${clock.since}`, source: 'the response clock [github]', text: lateText(clock, now, zone) }));
}
