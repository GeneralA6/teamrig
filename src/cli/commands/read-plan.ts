import { join } from 'node:path';
import { outsideUsageDir } from '../../budget/measure.ts';
import { planBody } from '../../interface/index.ts';
import { layoutPaths, MissingSegmentError } from '../../register/layout.ts';
import { NO_TASKS_ELSEWHERE, TaskTree, type TasksElsewhere } from '../../register/tree.ts';
import { teamZone } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { readWPerPct } from '../stored-week.ts';
import { teamRanking } from '../team-ranking.ts';
import { TreeTasks } from '../tree-tasks.ts';
import { teamsFolderOf, type KitTree, type TreeTeam } from '../tree.ts';
import { treeTeamsOf } from './read-sessions.ts';
import { belowOf, servedPathOf, stampsOf, workingSetOf, type DocumentSource, type ReadScope } from './read-source.ts';

/** The tasks the tree's other registers hold, or why they could not be read. */
type Elsewhere = { readonly tasks: TasksElsewhere; readonly problem: null } | { readonly tasks: null; readonly problem: string };

/**
 * `plan`: the team's active tasks in plan order, each with what teamrig's own task tree answers of it (the keys of
 * that order, its needs, who moves next), so a reader ranks nothing itself. It reads what `teamrig list` reads: the
 * config, the team's register, the register of every other team of its tree (a need held there), the goals of the
 * team and of the teams above it, and the metered spend a score's size is read from.
 *
 * Its revision covers each of them, the spend by the session stores' stamps and by the week's rate as read, which
 * is itself read from files this document cannot name ahead (the account's meter log, kept by another team). A
 * metered turn moves a session's store, so on a working team the revision moves at every turn, as the scores do:
 * `--unless` saves this document little there. The clock is no part of it; `validUntil` tells a reader when to ask
 * again with no file moved.
 *
 * Of another team's task it serves the id, the team, the owner and the status, and nothing else.
 */
export function planSource(scope: ReadScope): DocumentSource {
  const { runtime, kit, config } = scope;
  const team = kit.paths.team;
  const layout = layoutPaths(kit.paths.events);
  return {
    async parts() {
      const loaded = await scope.tree();
      const configs = [...[...loaded.teams.values()].map((other) => other.kit.load.path), ...[...loaded.leftOut.values()].map((load) => load.path)];
      const teams = treeTeamsOf(loaded, team);
      const rate = await readWPerPct(runtime, kit.paths, config, runtime.clock.now()).catch(() => undefined);
      return {
        document: 'plan',
        args: [
          ['team', team],
          ['owner', scope.owner],
        ],
        stamps: [
          // A team folder added or removed moves no file the tree read: the folder's own listing tells.
          (await runtime.files.list(teamsFolderOf(runtime))).join(','),
          ...(await stampsOf(runtime, configs)),
          ...(await registerStampsOf(runtime, teams)),
          ...(await stampsOf(runtime, teams.map((other) => other.kit.paths.goals))),
          ...(await folderStampsOf(runtime, kit.paths.usage)),
          ...(await folderStampsOf(runtime, outsideUsageDir(kit.paths.usage))),
          rate === undefined ? null : String(rate),
        ],
      };
    },
    async build() {
      const now = runtime.clock.now();
      const register = await workingSetOf(runtime, kit.paths, layout);
      const loaded = await scope.tree();
      const elsewhere = await elsewhereOf(runtime, loaded, team);
      const ranking = await teamRanking(runtime, kit.paths, config, register.tasks.values());
      const readable = elsewhere.tasks !== null;
      const tree = new TaskTree(readable ? register.tasks : new Map(), new Date(now), teamZone(config, runtime), undefined, elsewhere.tasks ?? NO_TASKS_ELSEWHERE, ranking);
      const body = planBody({
        tree,
        tasks: readable ? register.tasks.values() : [],
        owner: scope.owner,
        now,
        turns: { dueSoonDays: config.focus.score.dueSoonDays, parkAfterDays: config.focus.parkAfterDays },
      });
      return { body, problems: [...register.problems, ...(elsewhere.problem === null ? [] : [elsewhere.problem])] };
    },
  };
}

/**
 * The tasks of the tree's other registers. One whose archive lost a segment cannot be read, and a plan judged
 * without it would call a task ready whose need there is unfinished: no task is served then, and the problem names
 * the segment as its own team's folder holds it, never the reader's words for it.
 */
async function elsewhereOf(runtime: CliRuntime, loaded: KitTree, team: string): Promise<Elsewhere> {
  try {
    return { tasks: await new TreeTasks(runtime, loaded).elsewhereFor(team), problem: null };
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      return { tasks: null, problem: `${segmentNameOf(loaded, error.path)}: missing, so a register of the team tree cannot be read and the plan cannot be judged` };
    }
    throw error;
  }
}

function segmentNameOf(loaded: KitTree, path: string): string {
  const holder = [...loaded.teams.values()].find((other) => belowOf(other.kit.paths, path) !== undefined);
  return holder === undefined ? 'an archive segment of another team' : servedPathOf(holder.kit.paths, path);
}

/** What moves when a register of the tree does: its snapshot, its events after it, and its archive's segments by name. */
async function registerStampsOf(runtime: CliRuntime, teams: readonly TreeTeam[]): Promise<(string | null)[]> {
  const stamps: (string | null)[] = [];
  for (const { kit } of teams) {
    const layout = layoutPaths(kit.paths.events);
    stamps.push(...(await stampsOf(runtime, [layout.snapshot, layout.tail])), (await runtime.files.list(layout.archive)).join(','));
  }
  return stamps;
}

/** A folder's entries by name, then each one's stamp: a file added, removed or written moves it. */
async function folderStampsOf(runtime: CliRuntime, folder: string): Promise<(string | null)[]> {
  const names = (await runtime.files.list(folder)).sort();
  return [names.join(','), ...(await stampsOf(runtime, names.map((name) => join(folder, name))))];
}
