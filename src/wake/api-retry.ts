import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import { API_RETRY_LIMIT } from '../restore/api-error.ts';
import { costText, type WakeCost } from './decide.ts';

/**
 * The prompt and toast of a tab's retry after an API error (src/restore/api-error.ts `decideApiRetry`): its last turn
 * ended on an error a later try may not meet, so the work it was doing stopped mid-turn.
 */

/** Which retry this is (`n`, from 1) and the error its turn ended on, as the prompt and the toast say it. */
export interface ApiRetryFacts {
  readonly code: string;
  readonly failAt: number;
  readonly n: number;
}

/**
 * The prompt that sends the tab on: the error and when its turn failed on the team's clock, which retry this is, and
 * what it costs. A turn a wake had started failed before its work block began, so the prompt names the start too.
 */
export function apiRetryPrompt(session: string, retry: ApiRetryFacts, cost: WakeCost, zone: TimeZone): string {
  return (
    `Your last turn ended on an API error (${retry.code}) at ${zone.clock(new Date(retry.failAt))}; retry ${retry.n} of ${API_RETRY_LIMIT}. ` +
    `Go on with that turn's work (if a wake started it: \`${KIT_NAME} start --session ${session}\`). ` +
    `This retry costs ${costText(cost)}.`
  );
}

/** The person's toast: which error the tab's turn was sent again after, which retry this is, and what it costs. */
export function apiRetryToast(retry: ApiRetryFacts, cost: WakeCost): string {
  return `${KIT_NAME} retried this tab's turn that ended on an API error (${retry.code}), ${retry.n} of ${API_RETRY_LIMIT} (${costText(cost)})`;
}
