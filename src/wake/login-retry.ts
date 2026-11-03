import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import type { LoginRetryWhy } from '../restore/login.ts';
import { costText, type WakeCost } from './decide.ts';

/**
 * The prompt and toast of a stuck tab's retry (src/restore/login.ts `decideLoginRetry`): the tab's last turn ended on
 * `Login expired`, so the work it was doing stopped mid-turn, and a sign that the login works again sends it on.
 */

/** The sign each retry acts on, as the prompt and the toast say it. */
const SIGN: Readonly<Record<LoginRetryWhy, string>> = {
  recovered: 'the login works again',
  probe: 'the login was renewed since',
};

/**
 * The prompt that sends a stuck tab on: when its turn failed on the team's clock, the sign, and what it costs. A turn a
 * wake had started failed before its work block began, so the prompt names the start too.
 */
export function loginRetryPrompt(session: string, failAt: number, why: LoginRetryWhy, cost: WakeCost, zone: TimeZone): string {
  return (
    `Your last turn ended on Login expired at ${zone.clock(new Date(failAt))}; ${SIGN[why]}. ` +
    `Go on with that turn's work (if a wake started it: \`${KIT_NAME} start --session ${session}\`). ` +
    `This retry costs ${costText(cost)}.`
  );
}

/** The person's toast: why the tab's turn was sent again, and what it costs. */
export function loginRetryToast(why: LoginRetryWhy, cost: WakeCost): string {
  return `${KIT_NAME} retried this tab's turn that ended on Login expired: ${SIGN[why]} (${costText(cost)})`;
}
