import { isDefaultModel, isModel, launchOf } from '../config/launch.ts';
import { LeadTree } from '../config/lead-tree.ts';
import { ownerAsk } from '../config/tree.ts';
import type { EffortLevel, HiringConfig, KitConfig } from '../config/types.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { formatUtcDay, parseUtcDay } from '../core/time.ts';
import type { Checked } from '../setup/team-create.ts';
import type { HireRecord } from './record.ts';

/**
 * The plan behind `hire`: a new session written into the team config within `hiring`'s policy and
 * caps. Pure: it takes the file's JSON, the config read from it and the hires still active, and returns
 * the next JSON and the record to log, so the command can preview before it writes. The new file is
 * checked afterwards by the config parser every command reads with (the id's and name's rules live there).
 */

const DAY_MS = 86_400_000;

export interface HireRequest {
  readonly id: string;
  /** Its display and Claude Code session name, when not its id. */
  readonly name?: string;
  readonly scope: string;
  readonly reason: string;
  readonly approvedBy?: string;
  /** Unset: the lead's own. */
  readonly model?: string;
  /** Unset: the lead's own. */
  readonly effort?: EffortLevel;
  /** `YYYY-MM-DD`; unset: `hiring.reviewDays` from now. */
  readonly reviewBy?: string;
  /** The `at` of the burst it is hired for, checked by `burstHireOf` (src/hiring/burst-hire.ts). */
  readonly burst?: number;
  /** The session hiring it: the lead, or a sub-lead hiring into its own group. */
  readonly by: string;
  readonly now: number;
}

export interface HirePlan {
  /** The whole next config file. */
  readonly config: JsonRecord;
  readonly hire: HireRecord;
  /** The hired sessions on the team with this one. */
  readonly hired: number;
  /** Who leads the new session: the session that hired it, so a sub-lead's hire joins its group (T509). */
  readonly leader: string;
}

function recordAt(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

/** How many of the active hires are still on the team: a retired or removed one no longer counts against the cap. */
export function hiresOnTeam(config: Pick<KitConfig, 'sessions'>, active: readonly HireRecord[]): number {
  return active.filter((hire) => config.sessions.includes(hire.session)).length;
}

/**
 * Why one more hire beside the `hired` hires on the team ({@link hiresOnTeam}) would pass `hiring.maxSessions`;
 * undefined when it fits. A hire has no fixed daily budget, so the count is the only cap.
 */
export function hireCapProblem(hiring: Pick<HiringConfig, 'maxSessions'>, hired: number): string | undefined {
  return hired >= hiring.maxSessions ? `the team already has ${hired} hired session(s), the most hiring.maxSessions allows` : undefined;
}

function reviewDayOf(request: HireRequest, config: KitConfig): Checked<string> {
  if (request.reviewBy === undefined) {
    return { ok: true, value: formatUtcDay(new Date(request.now + config.hiring.reviewDays * DAY_MS)) };
  }
  const day = parseUtcDay(request.reviewBy);
  if (day === undefined) {
    return { ok: false, problem: `the review day "${request.reviewBy}" is not a YYYY-MM-DD date` };
  }
  if (formatUtcDay(day) < formatUtcDay(new Date(request.now))) {
    return { ok: false, problem: `the review day ${request.reviewBy} has passed` };
  }
  return { ok: true, value: formatUtcDay(day) };
}

/**
 * Why `by` may not hire, or undefined when it may: a lead hires, the team's lead or a sub-lead (T781), and a
 * sub-lead's hire joins its own group, so work it hires for never leaves the group (T509).
 */
export function hirerProblem(config: Pick<KitConfig, 'sessions' | 'roles' | 'leads'>, by: string): string | undefined {
  return new LeadTree(config).isLeader(by) ? undefined : `only a lead hires sessions: the lead (${config.roles.lead}), or a sub-lead into its own group`;
}

/** Whom the hirer asks for the owner's approval: a sub-lead its own leader, who takes it up; the lead {@link ownerAsk}. */
function approvalAsk(config: KitConfig, by: string): string {
  const leader = new LeadTree(config).leaderOf(by);
  return by === config.roles.lead || leader === undefined ? ownerAsk(config) : `${leader}, your leader, who takes it to the owner`;
}

/** The refusal under `hiring.policy`, or undefined when it allows this hire. */
function policyProblem(config: KitConfig, request: HireRequest): string | undefined {
  switch (config.hiring.policy) {
    case 'off':
      return 'hiring.policy is off: the team takes no hires by command';
    case 'owner':
      return request.approvedBy === undefined || request.approvedBy.trim() === ''
        ? `hiring.policy is owner: the owner approves each hire; ask ${approvalAsk(config, request.by)}, then pass --approved-by "<who>"`
        : undefined;
    case 'lead':
    case 'automatic':
      return undefined;
  }
}

/**
 * The new session written into `sessions`, `names` and `launch`, and its hire record; or why not. A sub-lead's hire is
 * also listed under it in `leads`. It launches on the lead's own model and effort unless told otherwise, whoever hires
 * it, so a burst hire stays on the lead's (src/hiring/burst-hire.ts). It gets no fixed daily budget: like any session,
 * its part of the team's daily budget follows its share and its queued work (src/budget/parts.ts).
 */
export function planHire(file: JsonRecord, config: KitConfig, active: readonly HireRecord[], request: HireRequest): Checked<HirePlan> {
  const refusal = hirerProblem(config, request.by) ?? policyProblem(config, request);
  if (refusal !== undefined) {
    return { ok: false, problem: refusal };
  }
  if (request.scope.trim() === '' || request.reason.trim() === '') {
    return { ok: false, problem: 'a hire needs its job (--scope) and why it is needed (--reason)' };
  }
  if (!ID_PATTERN.test(request.id)) {
    return { ok: false, problem: `"${request.id}" is not a session id: a lowercase letter, then up to 31 lowercase letters, digits or -` };
  }
  if (config.sessions.includes(request.id)) {
    return { ok: false, problem: `${request.id} is already on the team` };
  }
  const sessions = file['sessions'];
  if (!Array.isArray(sessions)) {
    return { ok: false, problem: 'the config has no sessions list to add to' };
  }
  const modelProblem = request.model === undefined ? undefined : isModel(request.model);
  if (modelProblem !== undefined) {
    return { ok: false, problem: `--model ${request.model}: ${modelProblem}` };
  }
  const hired = hiresOnTeam(config, active);
  const capProblem = hireCapProblem(config.hiring, hired);
  if (capProblem !== undefined) {
    return { ok: false, problem: capProblem };
  }
  const reviewBy = reviewDayOf(request, config);
  if (!reviewBy.ok) {
    return reviewBy;
  }
  const lead = config.roles.lead;
  const leads = lead === undefined ? {} : launchOf(config, lead);
  const model = request.model ?? leads.model;
  const effort = request.effort ?? leads.effort;
  const launch = { ...(isDefaultModel(model) ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  const subLead = request.by === lead ? undefined : request.by;
  const next: JsonRecord = {
    ...file,
    sessions: [...sessions, request.id],
    ...(request.name === undefined ? {} : { names: { ...recordAt(file, 'names'), [request.id]: request.name } }),
    launch: { ...recordAt(file, 'launch'), [request.id]: launch },
    ...(subLead === undefined ? {} : { leads: { ...recordAt(file, 'leads'), [subLead]: [...(config.leads[subLead] ?? []), request.id] } }),
  };
  const hire: HireRecord = {
    kind: 'hire',
    session: request.id,
    scope: request.scope.trim(),
    reason: request.reason.trim(),
    ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy.trim() }),
    ...launch,
    reviewBy: reviewBy.value,
    ...(request.burst === undefined ? {} : { burst: request.burst }),
    by: request.by,
    at: request.now,
  };
  return { ok: true, value: { config: next, hire, hired: hired + 1, leader: request.by } };
}
