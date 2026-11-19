import { isRightNow } from '../../config/priorities.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import type { SessionAddress } from '../../core/address.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME, type TeamPaths } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { Task } from '../../register/fold.ts';
import { priorityText } from '../../register/model.ts';
import type { Verdict } from '../../register/policy.ts';
import type { Register, WriteResult } from '../../register/register.ts';
import { TaskTree } from '../../register/tree.ts';
import { assignedNotice, dueTime, waitingOnYouText } from '../../register/views.ts';
import { WakeAsks } from '../../wake/asks.ts';
import { HELD_PRIORITY } from '../../wake/decide.ts';
import { closedByTeamrig, closedWakeLine, wakeClosedSession } from '../closed-wake.ts';
import { openTeamKit, requireConfig, rosterOf, teamZone, type Access, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { leadAboveOf } from '../tree.ts';
import { teamRegister } from '../team-register.ts';
import { askWake } from '../urgent-line.ts';
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
 * `inbox add --wake now` (T2686). `mayWake`: whether `by` may wake the owner as `inbox add --wake now` gates it
 * (wakeRefusal); a session of the owner's own team always may, so only an ask from another team passes it.
 */
export async function tellAssigned(runtime: CliRuntime, team: Team, by: string, task: Task, shown = task.owner, mayWake = true): Promise<boolean> {
  const text = assignedNotice(task, team.zone);
  const posted = await tellLine(runtime, team, by, task.owner, text, `${shown} was not told of ${task.id}`, shown);
  const closed = posted && (await reopenForUrgent(runtime, team, { by, mayWake }, task, text, shown));
  if (posted && !closed && task.priority === HELD_PRIORITY && team.config.wake.enabled) {
    runtime.out.stderr(`NOTE ${shown} is woken at its idle prompt for ${task.id}, a p0, so no --wake now is needed`);
  }
  return posted;
}

/**
 * Why a task handed to a closed owner reopens it now, or undefined when it waits for the idle pass: right-now work
 * (p0 or above, T4414), which the idle pass would reopen for only at its next minute, or with
 * `open.idle.reopenForDueToday` on, a task due today (or overdue), for which a closed session reopens only within
 * `wake.priority` or at its next day start, so a p2 due this afternoon waited for tomorrow (#1581).
 */
function urgentWhy(team: Team, task: Task, now: number): string | undefined {
  if (isRightNow(task.priority)) {
    return `is a ${priorityText(task.priority)}`;
  }
  const due = dueTime(task, team.zone);
  const today = due !== undefined && (due <= now || team.zone.day(new Date(due)) === team.zone.day(new Date(now)));
  return today && team.config.open.idle.reopenForDueToday ? 'is due today' : undefined;
}

/**
 * Right-now work or a task due today handed to a session teamrig closed ({@link urgentWhy}): its line gets a wake
 * ask, as `inbox add --wake now` does, and its reopen starts at once through the idle pass's own act
 * (src/cli/closed-wake.ts), the line saying REOPENS or CLOSED with why; true when the owner is closed. Only from an
 * adder that may wake the owner (`inbox add --wake now`'s gate): a wake spends the owner's turn and its team's budget
 * line, so an add from a session that may not wake it posts the line alone and says why. Nothing for an open
 * session, other work, or with the team's wakes off.
 */
async function reopenForUrgent(runtime: CliRuntime, team: Team, adder: { readonly by: string; readonly mayWake: boolean }, task: Task, text: string, shown: string): Promise<boolean> {
  const now = runtime.clock.now();
  const why = urgentWhy(team, task, now);
  if (why === undefined || !team.config.wake.enabled || !(await closedByTeamrig(runtime, team, task.owner))) {
    return false;
  }
  const { by } = adder;
  if (!adder.mayWake) {
    runtime.out.stderr(
      `NOTE ${shown} is closed and ${task.id} ${why}: its line is posted with no wake ask and no reopen, since ${by} may not wake it (a wake reaches another team only from a team lead); the idle pass reopens it for the line, or ask your lead to wake it`,
    );
    return true;
  }
  try {
    await new WakeAsks(runtime.files, team.paths.wakeAsks).post(task.owner, { from: by, text, at: now });
  } catch (error) {
    runtime.out.stderr(`WARN ${shown} is closed and its line has no wake ask (${errorMessage(error)}): ${KIT_NAME} open ${task.owner}`);
    return true;
  }
  const said = closedWakeLine(await wakeClosedSession(runtime, team, team.config, team.roster, task.owner), shown, task.owner, isRightNow(task.priority));
  if (said !== undefined) {
    runtime.out.stderr(`${said} (${task.id} ${why})`);
  }
  return true;
}

/**
 * Right-now work (p0 or above, T4414) a write left waiting on other sessions of the team ({@link TaskTree.waitsOn}):
 * each it newly waits on, by its add, a raised priority, a new owner or a new wait or need, gets a line saying what
 * (`T12 (p0, owner bravo) waits on your T7`) and a wake ask, and one teamrig closed reopens now, as `inbox add --wake
 * now` does: else the work waits for the receiver's next prompt, or for a closed one the idle pass's next minute. One
 * this write already told (`told`) gets the ask alone. Never the writer, nor a session of another team, whose wake
 * goes through its lead; nothing with the team's wakes off. The sessions it reached.
 */
export async function wakeWaitedOn(runtime: CliRuntime, team: Team, by: string, verdict: Verdict<WriteResult>, told: readonly string[]): Promise<readonly string[]> {
  if (!verdict.ok || !team.config.wake.enabled || !isRightNow(verdict.value.task.priority)) {
    return [];
  }
  const { task, before, state, elsewhere } = verdict.value;
  const now = runtime.clock.now();
  const tree = new TaskTree(state.tasks, new Date(now), team.zone, undefined, elsewhere);
  const earlier = new Set(before !== null && isRightNow(before.priority) ? tree.waitsOn(before).map((entry) => entry.session) : []);
  const place = { paths: team.paths, config: team.config, roster: async () => team.roster };
  const reached: string[] = [];
  for (const entry of tree.waitsOn(task)) {
    const { session } = entry;
    if (earlier.has(session) || session === by || !team.config.sessions.includes(session)) {
      continue;
    }
    const text = waitingOnYouText(entry);
    if (!told.includes(session) && !(await tellLine(runtime, team, by, session, text, `${session} was not told that ${task.id} waits on it`))) {
      continue;
    }
    runtime.out.stderr(`NOTE ${session} gets a wake ask: ${task.id} is a ${priorityText(task.priority)} waiting on it`);
    const problem = await askWake(runtime, place, { to: session, from: by, text }, now, true);
    if (problem !== undefined) {
      runtime.out.stderr(`WARN ${session} has the line, but ${problem}: ${KIT_NAME} inbox add --to ${session} --text "..." --wake now`);
    }
    reached.push(session);
  }
  return reached;
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
