import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { formatUtcDay } from '../core/time.ts';
import type { HireRecord } from './record.ts';

/**
 * The `check` flags on hired sessions: RETIRE-DUE when the burst it was hired for is over; REVIEW-DUE when its review
 * day has passed. A hire with no task stays on the team: the idle pass (src/cli/idle-pass.ts) deactivates it, it is
 * never due to retire for being idle. SCALE-OUT, on an area that needs a hire, is src/hiring/scale-out.ts. Pure: it
 * takes the hires still active, the bursts over and the clock's now.
 */

export const HIRE_FLAG_KINDS = ['SCALE-OUT', 'RETIRE-DUE', 'REVIEW-DUE'] as const;
export type HireFlagKind = (typeof HIRE_FLAG_KINDS)[number];

export interface HireFlag {
  readonly kind: HireFlagKind;
  /** The hired session, or the area a SCALE-OUT is on, so a session can find its own flags. */
  readonly session: string;
  readonly detail: string;
  /** What clears it, with the command. */
  readonly action: string;
}

export interface HireCheckInput {
  readonly hires: readonly HireRecord[];
  readonly config: Pick<KitConfig, 'sessions'>;
  /** The `at` of each burst over now (src/budget/burst.ts `burstsOver`). */
  readonly burstsOver: ReadonlySet<number>;
  readonly now: Date;
}

function retireDue(hire: HireRecord, burstsOver: ReadonlySet<number>): HireFlag | undefined {
  if (hire.burst === undefined || !burstsOver.has(hire.burst)) {
    return undefined;
  }
  return { kind: 'RETIRE-DUE', session: hire.session, detail: 'the burst it was hired for is over', action: `retire it (${KIT_NAME} retire ${hire.session})` };
}

function reviewDue(hire: HireRecord, now: Date): HireFlag | undefined {
  if (hire.reviewBy >= formatUtcDay(now)) {
    return undefined;
  }
  const action = `decide whether its job goes on, else retire it (${KIT_NAME} retire ${hire.session})`;
  return { kind: 'REVIEW-DUE', session: hire.session, detail: `review day ${hire.reviewBy} passed`, action };
}

/** The flags on each hired session still on the team, in hire order, RETIRE-DUE before REVIEW-DUE. */
export function hireFlags(input: HireCheckInput): HireFlag[] {
  return input.hires
    .filter((hire) => input.config.sessions.includes(hire.session))
    .flatMap((hire) => [retireDue(hire, input.burstsOver), reviewDue(hire, input.now)].filter((flag): flag is HireFlag => flag !== undefined));
}

/** One flag as `check` prints it, with what clears it. */
export function formatHireFlag(flag: HireFlag): string {
  return `HIRE ${flag.kind} (${flag.detail}) ${flag.session}: ${flag.action}`;
}
