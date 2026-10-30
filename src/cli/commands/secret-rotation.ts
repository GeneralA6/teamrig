import { roleHolderOf } from '../../config/roster.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import { errorMessage, stringField, type JsonRecord } from '../../core/guards.ts';
import type { TimeZone } from '../../core/zone.ts';
import type { Rotation } from '../../hooks/secret-redact.ts';
import type { Task } from '../../register/fold.ts';
import { ACTIVE_STATUSES } from '../../register/model.ts';
import type { AddInput } from '../../register/policy.ts';
import type { TasksElsewhere } from '../../register/tree.ts';
import { filedToday, SecretIncidentLog, type SecretIncident } from '../../secret-guard/incidents.ts';
import { taskRefOf } from '../inputs.ts';
import { teamZone } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { sessionScopeOf, teamScopeOf, type TeamScope } from './hook-input.ts';
import { teamOf, tellAssigned } from './register-team.ts';
import { askTeam, treeCallerOf } from './team-ask.ts';
import { fileLockOf } from '../file-locks.ts';

/** What a tool's result held: the tool, and each kind of secret found, by its shape's description. */
export interface Leak {
  readonly tool: string;
  readonly kinds: readonly string[];
  /** The accounts each kind's secrets belong to, by kind (see `Redaction.accounts`); a kind with none is absent. */
  readonly accounts: ReadonlyMap<string, readonly string[]>;
}

/** How long the redactor waits for another tab's rotation filing: the hook has 15 s, and its redaction must not wait on this. */
const LOCK_WAIT_MS = 3_000;

const every = (leak: Leak, problem: string): readonly Rotation[] => leak.kinds.map((kind) => ({ kind, problem }));

/**
 * Has each kind of secret a tool's result held rotated (T1369 R8): one register task for the team's security reviewer,
 * else its lead, per kind, session and day on the team's clock, and one line per kind in the team's incident log, with
 * the call that showed it (its id, the session's transcript and a helper's id) and the accounts a URL's credentials
 * named, which the task names too; never the value. A reviewer of a team
 * above (`<team>/<id>`) gets the task in that team's register, as an ask of the session's. A kind its session was given
 * a task for that day names that task again while it is still active; a closed one (a false positive, say) gets a new
 * task, so a real leak later that day is never folded into a task no one works (T1545). Nothing here throws: a filing
 * that fails is that kind's problem, and the redaction is sent either way.
 */
export async function fileRotations(runtime: CliRuntime, payload: JsonRecord, leak: Leak): Promise<readonly Rotation[]> {
  try {
    const team = await teamScopeOf(runtime, payload);
    if (team === undefined) {
      return every(leak, "the tab's team has no loaded config");
    }
    const session = (await sessionScopeOf(runtime, team, payload))?.id;
    const lock = fileLockOf(runtime, team.kit.paths.secretIncidentsLock, { ...team.config.lock, waitMs: LOCK_WAIT_MS });
    return await lock.run(() => rotateEach(runtime, team, session, callOf(payload), leak));
  } catch (error) {
    return every(leak, errorMessage(error));
  }
}

/** The call whose result held the leak, as the hook's payload names it, for the incident log (T1545). */
type Call = Pick<SecretIncident, 'toolUseId' | 'transcript' | 'agent'>;

function callOf(payload: JsonRecord): Call {
  const toolUseId = stringField(payload, 'tool_use_id');
  const transcript = stringField(payload, 'transcript_path');
  const agent = stringField(payload, 'agent_id');
  return { ...(toolUseId === undefined ? {} : { toolUseId }), ...(transcript === undefined ? {} : { transcript }), ...(agent === undefined ? {} : { agent }) };
}

async function rotateEach(runtime: CliRuntime, team: TeamScope, session: string | undefined, call: Call, leak: Leak): Promise<readonly Rotation[]> {
  const log = new SecretIncidentLog(runtime.files, team.kit.paths.secretIncidents);
  const { incidents } = await log.read();
  const now = new Date(runtime.clock.now());
  const zone = teamZone(team.config, runtime);
  const rotations: Rotation[] = [];
  for (const kind of leak.kinds) {
    const accounts = leak.accounts.get(kind);
    const named = accounts === undefined ? {} : { accounts };
    const rotation = session === undefined ? { kind, problem: "this tab's session is not known" } : await rotationOf(runtime, team, { session, tool: leak.tool, kind, ...named }, incidents, zone);
    rotations.push(rotation);
    const incident: SecretIncident = { at: now.toISOString(), ...(session === undefined ? {} : { session }), tool: leak.tool, ...call, kind, ...named, ...('task' in rotation ? { task: rotation.task } : {}) };
    // The task is filed either way; a lost line only lets the next incident that day try again, which the register
    // refuses as a copy of the open task.
    await log.append(incident).catch(() => undefined);
  }
  return rotations;
}

interface Sighting {
  readonly session: string;
  readonly tool: string;
  readonly kind: string;
  /** Whose secrets they were (`login app at github.com`); absent for a kind that names none. */
  readonly accounts?: readonly string[];
}

async function rotationOf(runtime: CliRuntime, team: TeamScope, sighting: Sighting, incidents: readonly SecretIncident[], zone: TimeZone): Promise<Rotation> {
  const { kind } = sighting;
  const now = new Date(runtime.clock.now());
  const filed = filedToday(incidents, kind, sighting.session, now, zone);
  try {
    if (filed !== undefined && (await stillActive(runtime, team, filed))) {
      return { kind, task: filed };
    }
    const reviewer = roleHolderOf(team.config.roles, 'securityReviewer', team.kit.paths.team) ?? { team: team.kit.paths.team, id: team.config.roles.lead };
    return await fileRotation(runtime, team, reviewer, sighting, rotationInput(sighting, zone.day(now), team.config.register.maxTitle));
  } catch (error) {
    return { kind, problem: errorMessage(error) };
  }
}

/**
 * Whether the task a kind was given, `T12` in the team's register or `web/T12` in another of its tree, is still open,
 * in progress, waiting or verifying; a task the named register no longer holds is not. The tree's other registers are
 * read outright: the register's own tasks need not wait on any of them.
 */
async function stillActive(runtime: CliRuntime, team: TeamScope, filed: string): Promise<boolean> {
  const ref = taskRefOf(filed);
  const { register } = await teamOf(runtime, team.kit, 'read');
  const held = ref.team === undefined ? (await register.snapshot()).state.tasks.get(ref.id) : heldBy(await register.elsewhere(), ref.team, ref.id);
  return held !== undefined && ACTIVE_STATUSES.includes(held.status);
}

function heldBy(elsewhere: TasksElsewhere, holder: string, id: string): Task | undefined {
  const found = elsewhere.get(id);
  return found?.team === holder ? found.task : undefined;
}

/**
 * The task: what leaked where and on which day, with whose accounts, in plain words, and never the value or a file's
 * path. The day keeps a later day's task from being refused as a copy of an earlier one still open.
 */
function rotationInput(sighting: Sighting, day: string, maxTitle: number): Omit<AddInput, 'owner' | 'source'> {
  const { session, tool, kind, accounts } = sighting;
  const title = `Rotate the ${kind} a ${tool} result showed ${session} on ${day}`;
  const whose = accounts === undefined ? '' : ` (${accounts.join('; ')})`;
  return {
    title: title.length <= maxTitle ? title : `Rotate the secret a ${tool} result showed ${session} on ${day}`,
    description: `The secret redactor found a ${kind}${whose} in a ${tool} result of session ${session} and replaced it before the model saw it. Treat it as leaked: rotate it where it was issued, then close this task. The team's secret incident log names the kind, accounts, session, tool and call; no log holds the value.`,
    priority: 1,
  };
}

async function fileRotation(runtime: CliRuntime, team: TeamScope, reviewer: SessionAddress, sighting: Sighting, input: Omit<AddInput, 'owner' | 'source'>): Promise<Rotation> {
  const { kind, session } = sighting;
  const own = team.kit.paths.team;
  if (reviewer.team !== own) {
    const caller = await treeCallerOf(runtime, own, session, reviewer.team);
    const { verdict } = await askTeam(runtime, caller, { asked: reviewer.team, owner: reviewer.id }, input);
    return verdict.ok ? { kind, task: formatAddress({ team: reviewer.team, id: verdict.value.task.id }) } : { kind, problem: verdict.error };
  }
  const written = await teamOf(runtime, team.kit, 'write');
  const verdict = await written.register.add(session, { ...input, owner: reviewer.id, source: session });
  if (!verdict.ok) {
    return { kind, problem: verdict.error };
  }
  const { task } = verdict.value;
  if (task.owner !== session) {
    await tellAssigned(runtime, written, session, task);
  }
  return { kind, task: task.id };
}
