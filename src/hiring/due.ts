import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { formatUtcDay } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import type { HireRecord } from './log.ts';

/**
 * The `check` flags on hired sessions: RETIRE-DUE when one has had no open task for `hiring.idleHours`
 * (since its hire, or since its newest task took its closed status), REVIEW-DUE when its review day has
 * passed. Pure: it takes the hires still active, the team's tasks and the clock's now.
 */

export const HIRE_FLAG_KINDS = ['RETIRE-DUE', 'REVIEW-DUE'] as const;
export type HireFlagKind = (typeof HIRE_FLAG_KINDS)[number];

export interface HireFlag {
  readonly kind: HireFlagKind;
  /** The hired session, so a session can find its own flags. */
  readonly session: string;
  readonly detail: string;
}

export interface HireCheckInput {
  readonly hires: readonly HireRecord[];
  readonly tasks: Iterable<Task>;
  readonly config: Pick<KitConfig, 'sessions' | 'hiring'>;
  readonly now: Date;
}

const HOUR_MS = 3_600_000;

/** When the session last had an open task: its hire, or the newest status change of the tasks it owns. */
function idleSince(hire: HireRecord, owned: readonly Task[]): number {
  return owned.reduce((latest, task) => Math.max(latest, Date.parse(task.statusAt)), hire.at);
}

function retireDue(hire: HireRecord, owned: readonly Task[], input: HireCheckInput): HireFlag | undefined {
  if (owned.some((task) => ACTIVE_STATUSES.includes(task.status))) {
    return undefined;
  }
  const { idleHours } = input.config.hiring;
  const hours = Math.floor((input.now.getTime() - idleSince(hire, owned)) / HOUR_MS);
  return hours < idleHours ? undefined : { kind: 'RETIRE-DUE', session: hire.session, detail: `no open task for ${hours} h, hiring.idleHours ${idleHours}` };
}

function reviewDue(hire: HireRecord, now: Date): HireFlag | undefined {
  return hire.reviewBy < formatUtcDay(now) ? { kind: 'REVIEW-DUE', session: hire.session, detail: `review day ${hire.reviewBy} passed` } : undefined;
}

/** The flags on each hired session still on the team, in hire order, RETIRE-DUE before REVIEW-DUE. */
export function hireFlags(input: HireCheckInput): HireFlag[] {
  const tasks = [...input.tasks];
  return input.hires
    .filter((hire) => input.config.sessions.includes(hire.session))
    .flatMap((hire) => {
      const owned = tasks.filter((task) => task.owner === hire.session);
      return [retireDue(hire, owned, input), reviewDue(hire, input.now)].filter((flag): flag is HireFlag => flag !== undefined);
    });
}

/** One flag as `check` prints it, with the command that clears it. */
export function formatHireFlag(flag: HireFlag): string {
  const action = flag.kind === 'RETIRE-DUE' ? 'retire it' : 'decide whether its job goes on, else retire it';
  return `HIRE ${flag.kind} (${flag.detail}) ${flag.session}: ${action} (${KIT_NAME} retire ${flag.session})`;
}
