import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import type { SessionAddress } from '../../core/address.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME, type TeamPaths } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { Task } from '../../register/fold.ts';
import type { Register } from '../../register/register.ts';
import { assignedNotice, dueTime } from '../../register/views.ts';
import { WakeAsks } from '../../wake/asks.ts';
import { HELD_PRIORITY } from '../../wake/decide.ts';
import { closedByTeamrig, closedWakeLine, wakeClosedSession } from '../closed-wake.ts';
import { openTeamKit, requireConfig, rosterOf, teamZone, type Access, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { leadAboveOf } from '../tree.ts';
import { teamRegister } from '../team-register.ts';
import { inboxDepsOf } from './inbox.ts';

/** A team a register command reads or writes: its config, register and roster, and the zone its people read times in. */
export interface Team {
  readonly config: KitConfig;
  readonly paths: TeamPaths;
  readonly register: Register;
  readonly roster: Roster;
  /** The zone the team's people read and type times in. */
  readonly zone: TimeZone;
  /** The parent team's lead, who approves the lead's own work (T1140); undefined on a root team. */
  readonly above: SessionAddress | undefined;
}

export async function teamOf(runtime: CliRuntime, kit: Kit, access: Access): Promise<Team> {
  const config = requireConfig(kit, runtime, access);
  const above = await leadAboveOf(runtime, kit.paths.team, config);
  return { config, paths: kit.paths, register: teamRegister(runtime, kit.paths, config, above), roster: await rosterOf(runtime, kit, config), zone: teamZone(config, runtime), above };
}

export async function openTeam(runtime: CliRuntime, access: Access): Promise<Team> {
  return teamOf(runtime, await openTeamKit(runtime), access);
}

/**
 * One inbox line telling a task's owner the task is its own, true when posted; `shown` names the owner in the NOTE
 * (another team's by address). A p0 task also says the owner is woken: its team's wake check wakes an idle owner for
 * it (src/wake/decide.ts: a p0 wakes even past the budget and in blocking quiet hours), so the asker needs no
 * `inbox add --wake now` (T2686).
 */
export async function tellAssigned(runtime: CliRuntime, team: Team, by: string, task: Task, shown = task.owner): Promise<boolean> {
  const text = assignedNotice(task, team.zone);
  const posted = await tellLine(runtime, team, by, task.owner, text, `${shown} was not told of ${task.id}`, shown);
  if (posted) {
    await reopenForDueToday(runtime, team, by, task, text, shown);
  }
  if (posted && task.priority === HELD_PRIORITY && team.config.wake.enabled) {
    runtime.out.stderr(`NOTE ${shown} is woken at its idle prompt for ${task.id}, a p0, so no --wake now is needed`);
  }
  return posted;
}

/**
 * A task due today (or overdue) handed to a session teamrig closed (#1581): a closed session reopens for work only
 * within `wake.priority` or at its next day start, so a p2 due this afternoon waited for tomorrow. Its line gets a
 * wake ask, as `inbox add --wake now` does, and its reopen starts at once through the idle pass's own act
 * (src/cli/closed-wake.ts), the line saying REOPENS or CLOSED with why. Nothing for an open session, a task with no due
 * time or one due a later day, or with the team's wakes off.
 */
async function reopenForDueToday(runtime: CliRuntime, team: Team, by: string, task: Task, text: string, shown: string): Promise<void> {
  const due = dueTime(task, team.zone);
  const now = runtime.clock.now();
  const today = due !== undefined && (due <= now || team.zone.day(new Date(due)) === team.zone.day(new Date(now)));
  if (!today || !team.config.wake.enabled || !(await closedByTeamrig(runtime, team, task.owner))) {
    return;
  }
  try {
    await new WakeAsks(runtime.files, team.paths.wakeAsks).post(task.owner, { from: by, text, at: now });
  } catch (error) {
    runtime.out.stderr(`WARN ${shown} is closed and its line has no wake ask (${errorMessage(error)}): ${KIT_NAME} open ${task.owner}`);
    return;
  }
  const said = closedWakeLine(await wakeClosedSession(runtime, team, team.config, team.roster, task.owner), shown, task.owner);
  if (said !== undefined) {
    runtime.out.stderr(`${said} (${task.id} is due today)`);
  }
}

/**
 * The answer to a task's approval wait, told to its owner (T1422): the inbox line, and with the team's wakes on a wake
 * ask too (src/wake/asks.ts), as an `inbox add --wake now` line gets, so an idle tab wakes on it and the idle pass's
 * reopen of a closed one quotes it. A plain line is read only at the owner's next prompt, and an idle owner has none:
 * approved work sat 14 h. An ask that cannot be posted is a WARN, the line already told.
 */
export async function tellAnswer(runtime: CliRuntime, team: Team, by: string, to: string, text: string, unsent: string, shown = to): Promise<void> {
  if (!(await tellLine(runtime, team, by, to, text, unsent, shown)) || !team.config.wake.enabled) {
    return;
  }
  try {
    await new WakeAsks(runtime.files, team.paths.wakeAsks).post(to, { from: by, text, at: runtime.clock.now() });
  } catch (error) {
    runtime.out.stderr(`WARN ${shown} has the line, but its idle tab is not woken for it (${errorMessage(error)}): ${KIT_NAME} inbox add --to ${shown} --text "..." --wake now`);
  }
}

/** Posts one inbox line, naming it on stderr, or naming `unsent` and why: a line that cannot be posted is never thrown. */
export async function tellLine(runtime: CliRuntime, team: Team, by: string, to: string, text: string, unsent: string, shown = to): Promise<boolean> {
  return postNamed(runtime, team.paths, new SecretScanner(team.config.register.secretPatterns), { to, from: by, text }, unsent, shown);
}

/** Posts one line to an inbox of the team at `paths`, naming it on stderr as `shown`, or naming `unsent` and why; true when posted. */
export async function postNamed(
  runtime: CliRuntime,
  paths: TeamPaths,
  secrets: SecretScanner,
  line: { readonly to: string; readonly from: string; readonly text: string },
  unsent: string,
  shown: string,
): Promise<boolean> {
  const { inboxes } = inboxDepsOf(runtime, paths);
  const problem = await postLine(inboxes, secrets, { ...line, now: new Date(runtime.clock.now()) });
  runtime.out.stderr(problem === undefined ? `NOTE ${shown} has an inbox line: ${line.text}` : `WARN ${unsent}: ${problem}`);
  return problem === undefined;
}
