import { relative } from 'node:path';
import { formatConfig } from '../../config/load.ts';
import type { Roster } from '../../config/roster.ts';
import { claudeConfigDir, resolveKitHome, teamPaths, type TeamPaths } from '../../core/home.ts';
import { InboxDir } from '../../inbox/store.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { TASK_STATUSES } from '../../register/model.ts';
import { sessionFilesOf } from '../../setup/session-files.ts';
import { teamSpecOf } from '../../setup/team-create.ts';
import { planTeamSplit, type SplitPlan } from '../../setup/team-split.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf, listOf } from '../inputs.ts';
import { configFileJson, leadOnly, openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';
import { loadTree } from '../tree.ts';
import { warnDamage } from './register.ts';

/**
 * `team split <child> --lead <id> --sessions <id,id> --dry-run`: the lead's plan for moving sessions of its team, with
 * the tasks they own, into a new child team under it (T1144). It plans only, so it runs with --dry-run alone: the
 * child's config, what the parent's config loses, the tasks that move, the links and names that cross the new border,
 * and each moved session's inbox, files and renames.
 */

/** What a moved session leaves in the parent's folders: its inbox lines, the files kept for it and its renames. */
interface SessionLeft {
  readonly id: string;
  readonly inboxLines: number;
  readonly files: readonly string[];
  readonly renames: number;
}

async function sessionsLeftOf(runtime: CliRuntime, paths: TeamPaths, ids: readonly string[]): Promise<SessionLeft[]> {
  const inbox = new InboxDir(runtime.files, paths.inbox);
  const { renames } = await new JsonlRenameLog(runtime.files, paths.renames).read();
  const left: SessionLeft[] = [];
  for (const id of ids) {
    const files: string[] = [];
    for (const path of sessionFilesOf(paths, id)) {
      if ((await runtime.probe.kind(path)) !== 'none') {
        files.push(relative(paths.home, path));
      }
    }
    left.push({ id, inboxLines: (await inbox.lines(id))?.length ?? 0, files, renames: renames.filter((rename) => rename.id === id).length });
  }
  return left;
}

/** `<id> (<name>)`, the way the plan names a session. */
function named(roster: Roster, id: string): string {
  return `${id} (${roster.nameOf(id) ?? id})`;
}

/** The moving tasks of one owner, counted by status in the register's status order. */
function statusCounts(plan: SplitPlan, owner: string): string {
  const owned = plan.moving.filter((task) => task.owner === owner);
  return TASK_STATUSES.flatMap((status) => {
    const count = owned.filter((task) => task.status === status).length;
    return count === 0 ? [] : [`${count} ${status}`];
  }).join(', ');
}

function planLines(plan: SplitPlan, parent: string, roster: Roster, configPaths: { child: string; parent: string }, left: readonly SessionLeft[]): string[] {
  const { spec, trim } = plan;
  const sideOf = (moves: boolean): string => (moves ? spec.team : parent);
  return [
    'DRY RUN nothing is written; team split only plans for now',
    `TEAM ${spec.team} under ${parent}: lead ${named(roster, spec.lead)}; sessions ${spec.sessions.map((id) => named(roster, id)).join(', ')}`,
    `WOULD CREATE ${configPaths.child}:`,
    ...formatConfig(plan.config).trimEnd().split('\n'),
    `PARENT ${configPaths.parent} loses sessions ${spec.sessions.join(', ')}${trim.keys.length === 0 ? '' : ` and keys ${trim.keys.join(', ')}`}`,
    ...trim.leftLeads.map(({ lead, id }) => `SUB-LEAD ${lead}'s list loses ${id}, which moves`),
    ...trim.unled.map(({ lead, id }) => `UNLED ${id}: its sub-lead ${lead} moves, so the lead leads it`),
    `TASKS ${plan.moving.length} move to ${spec.team}, ${plan.staying} stay in ${parent}`,
    ...spec.sessions.flatMap((id) => {
      const counts = statusCounts(plan, id);
      return counts === '' ? [] : [`  ${id}: ${counts}`];
    }),
    ...plan.links.map((link) => {
      const relation = link.kind === 'after' ? 'runs after' : 'waits on';
      return `LINK ${link.task} in ${sideOf(link.taskMoves)} ${relation} ${link.on} in ${sideOf(!link.taskMoves)}`;
    }),
    ...plan.rewrites.map((rewrite) => `REWRITE ${rewrite.task} ${rewrite.field} ${rewrite.from} -> ${rewrite.to}`),
    ...left.flatMap((session) => [
      ...(session.inboxLines === 0 ? [] : [`INBOX ${session.id}: ${session.inboxLines} line(s) move`]),
      ...(session.files.length === 0 ? [] : [`FILES ${session.id}: ${session.files.join(', ')}`]),
      ...(session.renames === 0 ? [] : [`RENAMES ${session.id}: ${session.renames} rename line(s) move`]),
    ]),
  ];
}

export async function teamSplit(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const child = onePositional(args, 'team');
  if (!args.switches.has('dry-run')) {
    throw new RefusedError('team split only plans for now: run it with --dry-run to see what it would move');
  }
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  leadOnly(roster, callerOf(args.flags, runtime.env), 'splits the team');
  const lead = sessionIdOf(roster, requiredFlag(args.flags, 'lead'));
  const sessions = listOf('--sessions', requiredFlag(args.flags, 'sessions')).map((each) => sessionIdOf(roster, each));
  const spec = teamSpecOf(child, sessions.join(','), lead, kit.paths.team);
  if (!spec.ok) {
    throw new UsageError(spec.problem);
  }
  const childPaths = teamPaths(resolveKitHome(runtime.env, runtime.userHome), child, claudeConfigDir(runtime.env, runtime.userHome));
  if ((await runtime.probe.kind(childPaths.home)) !== 'none') {
    throw new RefusedError(`${childPaths.home} exists already; a split makes a new team`);
  }
  const snapshot = await teamRegister(runtime, kit.paths, config).snapshot();
  warnDamage(runtime, snapshot, kit.paths.events);
  const parent = { team: kit.paths.team, config, record: await configFileJson(runtime, kit.load.path), roster };
  const planned = planTeamSplit(parent, spec.value, (await loadTree(runtime)).tree, snapshot.state.tasks);
  if (!planned.ok) {
    throw new RefusedError(planned.problem);
  }
  const left = await sessionsLeftOf(runtime, kit.paths, spec.value.sessions);
  planLines(planned.value, kit.paths.team, roster, { child: childPaths.config, parent: kit.load.path }, left).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}
