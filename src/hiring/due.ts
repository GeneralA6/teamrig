import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { formatUtcDay } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import type { HireRecord } from './record.ts';

/**
 * The `check` flags on hired sessions: RETIRE-DUE when the burst it was hired for is over, or when it has
 * had no open task for `hiring.idleHours` (since its hire, or since its newest task took its closed status) and no
 * SCALE-OUT gives it a slice; REVIEW-DUE when its review day has passed. SCALE-OUT, on an area that needs a hire, is
 * src/hiring/scale-out.ts. Pure: it takes the hires still active, the team's tasks, the bursts over and the clock's now.
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
  readonly tasks: Iterable<Task>;
  readonly config: Pick<KitConfig, 'sessions' | 'hiring'>;
  /** The `at` of each burst over now (src/budget/burst.ts `burstsOver`). */
  readonly burstsOver: ReadonlySet<number>;
  readonly now: Date;
}

const HOUR_MS = 3_600_000;

/** When the session last had an open task: its hire, or the newest status change of the tasks it owns. */
function idleSince(hire: HireRecord, owned: readonly Task[]): number {
  return owned.reduce((latest, task) => Math.max(latest, Date.parse(task.statusAt)), hire.at);
}

function retireFlag(session: string, detail: string): HireFlag {
  return { kind: 'RETIRE-DUE', session, detail, action: `retire it (${KIT_NAME} retire ${session})` };
}

function retireDue(hire: HireRecord, owned: readonly Task[], input: HireCheckInput, busy: ReadonlySet<string>): HireFlag | undefined {
  if (hire.burst !== undefined && input.burstsOver.has(hire.burst)) {
    return retireFlag(hire.session, 'the burst it was hired for is over');
  }
  if (busy.has(hire.session) || owned.some((task) => ACTIVE_STATUSES.includes(task.status))) {
    return undefined;
  }
  const { idleHours } = input.config.hiring;
  const hours = Math.floor((input.now.getTime() - idleSince(hire, owned)) / HOUR_MS);
  return hours < idleHours ? undefined : retireFlag(hire.session, `no open task for ${hours} h, hiring.idleHours ${idleHours}`);
}

function reviewDue(hire: HireRecord, now: Date): HireFlag | undefined {
  if (hire.reviewBy >= formatUtcDay(now)) {
    return undefined;
  }
  const action = `decide whether its job goes on, else retire it (${KIT_NAME} retire ${hire.session})`;
  return { kind: 'REVIEW-DUE', session: hire.session, detail: `review day ${hire.reviewBy} passed`, action };
}

/**
 * The flags on each hired session still on the team, in hire order, RETIRE-DUE before REVIEW-DUE. `busy` holds the
 * idle hires a SCALE-OUT gives a slice (src/hiring/scale-out.ts), which are not due to retire for being idle.
 */
export function hireFlags(input: HireCheckInput, busy: ReadonlySet<string> = new Set()): HireFlag[] {
  const tasks = [...input.tasks];
  return input.hires
    .filter((hire) => input.config.sessions.includes(hire.session))
    .flatMap((hire) => {
      const owned = tasks.filter((task) => task.owner === hire.session);
      return [retireDue(hire, owned, input, busy), reviewDue(hire, input.now)].filter((flag): flag is HireFlag => flag !== undefined);
    });
}

/** One flag as `check` prints it, with what clears it. */
export function formatHireFlag(flag: HireFlag): string {
  return `HIRE ${flag.kind} (${flag.detail}) ${flag.session}: ${flag.action}`;
}
