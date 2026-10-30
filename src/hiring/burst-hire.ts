import type { Burst } from '../budget/burst.ts';
import { isDefaultModel, launchOf } from '../config/launch.ts';
import { EFFORT_LEVELS, type KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { Checked } from '../setup/team-create.ts';
import type { HireRecord } from './record.ts';
import type { HireRequest } from './plan.ts';

/**
 * A hire for the burst in force (`hire --burst`): within the burst's own hires, on the lead's model and at
 * least the lead's effort, never a cheaper model or a lower effort, and tied to the burst so `check` flags it
 * RETIRE-DUE once the burst is over. Under `hiring.policy` owner the burst's approver approves it unless the
 * line names one: the owner approved the burst's hires with the burst. Pure: it takes the request, the burst
 * in force, the hires still active and the config; `planHire` then applies `hiring`'s own policy.
 */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** True when both name the same model, the default one included. */
function sameModel(model: string, leads: string | undefined): boolean {
  return isDefaultModel(model) ? isDefaultModel(leads) : model === leads;
}

/** The request tied to the burst, or why the burst takes no such hire. */
export function burstHireOf(request: HireRequest, burst: Burst | undefined, active: readonly HireRecord[], config: KitConfig): Checked<HireRequest> {
  if (burst === undefined) {
    return { ok: false, problem: `no burst is in force: hire --burst hires for one (${KIT_NAME} burst)` };
  }
  const taken = active.filter((hire) => hire.burst === burst.at && config.sessions.includes(hire.session)).length;
  if (taken >= burst.hires) {
    return { ok: false, problem: `the burst allows ${plural(burst.hires, 'hire')}, and ${taken} ${taken === 1 ? 'is' : 'are'} on the team` };
  }
  const leads = launchOf(config, config.roles.lead);
  if (request.model !== undefined && !sameModel(request.model, leads.model)) {
    return { ok: false, problem: `--model ${request.model}: a burst hire runs on the lead's model (${leads.model ?? 'the default'}), never another` };
  }
  if (request.effort !== undefined && leads.effort !== undefined && EFFORT_LEVELS.indexOf(request.effort) < EFFORT_LEVELS.indexOf(leads.effort)) {
    return { ok: false, problem: `--effort ${request.effort} is below the lead's ${leads.effort}: a burst never lowers effort` };
  }
  const approvedBy = request.approvedBy ?? burst.approvedBy;
  return { ok: true, value: { ...request, ...(approvedBy === undefined ? {} : { approvedBy }), burst: burst.at } };
}
