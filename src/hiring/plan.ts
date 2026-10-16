import { isDefaultModel, isModel, launchOf } from '../config/launch.ts';
import type { EffortLevel, KitConfig } from '../config/types.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { formatUtcDay, parseUtcDay } from '../core/time.ts';
import type { Checked } from '../setup/team-create.ts';
import type { HireRecord } from './log.ts';

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
  /** Unset: `hiring.dailyPct`. */
  readonly dailyPct?: number;
  /** `YYYY-MM-DD`; unset: `hiring.reviewDays` from now. */
  readonly reviewBy?: string;
  /** The session hiring it. */
  readonly by: string;
  readonly now: number;
}

export interface HirePlan {
  /** The whole next config file. */
  readonly config: JsonRecord;
  readonly hire: HireRecord;
  /** The hired sessions on the team with this one, and the sum of their daily budgets. */
  readonly hired: number;
  readonly hiredDailyPct: number;
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function recordAt(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

/** A hire's daily budget as the config has it now, so a later `budget` change counts. */
function dailyPctOf(config: KitConfig, hire: HireRecord): number {
  return ownValue(config.budget.sessions, hire.session)?.dailyPct ?? hire.dailyPct;
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

/** The refusal under `hiring.policy`, or undefined when it allows this hire. */
function policyProblem(config: KitConfig, request: HireRequest): string | undefined {
  switch (config.hiring.policy) {
    case 'off':
      return 'hiring.policy is off: the team takes no hires by command';
    case 'owner':
      return request.approvedBy === undefined || request.approvedBy.trim() === ''
        ? 'hiring.policy is owner: the owner approves each hire; ask them, then pass --approved-by "<who>"'
        : undefined;
    case 'lead':
      return undefined;
  }
}

/** The new session written into `sessions`, `names`, `launch` and `budget.sessions`, and its hire record; or why not. */
export function planHire(file: JsonRecord, config: KitConfig, active: readonly HireRecord[], request: HireRequest): Checked<HirePlan> {
  const refusal = policyProblem(config, request);
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
  const { maxSessions, maxDailyPct } = config.hiring;
  const onTeam = active.filter((hire) => config.sessions.includes(hire.session));
  if (onTeam.length >= maxSessions) {
    return { ok: false, problem: `the team already has ${onTeam.length} hired session(s), the most hiring.maxSessions allows` };
  }
  const dailyPct = request.dailyPct ?? config.hiring.dailyPct;
  // To hundredths, so 0.1 + 0.2 meets a cap of 0.3.
  const hiredDailyPct = Math.round(onTeam.reduce((sum, hire) => sum + dailyPctOf(config, hire), dailyPct) * 100) / 100;
  if (hiredDailyPct > maxDailyPct) {
    return { ok: false, problem: `the hired sessions' daily budgets would add up to ${hiredDailyPct}% of the week, over hiring.maxDailyPct ${maxDailyPct}%` };
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
  const budget = recordAt(file, 'budget');
  const next: JsonRecord = {
    ...file,
    sessions: [...sessions, request.id],
    ...(request.name === undefined ? {} : { names: { ...recordAt(file, 'names'), [request.id]: request.name } }),
    launch: { ...recordAt(file, 'launch'), [request.id]: launch },
    budget: { ...budget, sessions: { ...recordAt(budget, 'sessions'), [request.id]: { dailyPct } } },
  };
  const hire: HireRecord = {
    kind: 'hire',
    session: request.id,
    scope: request.scope.trim(),
    reason: request.reason.trim(),
    ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy.trim() }),
    ...launch,
    dailyPct,
    reviewBy: reviewBy.value,
    by: request.by,
    at: request.now,
  };
  return { ok: true, value: { config: next, hire, hired: onTeam.length + 1, hiredDailyPct } };
}
