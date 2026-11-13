import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import type { SessionAddress } from '../../core/address.ts';
import type { TeamPaths } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { Task } from '../../register/fold.ts';
import type { Register } from '../../register/register.ts';
import { assignedNotice } from '../../register/views.ts';
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

/** One inbox line telling a task's owner the task is its own, true when posted; `shown` names the owner in the NOTE (another team's by address). */
export async function tellAssigned(runtime: CliRuntime, team: Team, by: string, task: Task, shown = task.owner): Promise<boolean> {
  return tellLine(runtime, team, by, task.owner, assignedNotice(task, team.zone), `${shown} was not told of ${task.id}`, shown);
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
