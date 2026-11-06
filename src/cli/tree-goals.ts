import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { NO_GOAL_TAGS, readGoals, type Goal } from '../register/goals.ts';
import type { GoalTagsReader } from '../register/register.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree } from './tree.ts';

/**
 * The goal tags a team's task may name under `register.goals` checked or required (T1730): the tags of the team's own
 * goal records and of every team above it, up to the root, as its kit home stands at the call; a sibling team's goals
 * are not among them. Under `free` nothing is read, and a root team reads only its own file, not the tree.
 */
export class KitTreeGoals implements GoalTagsReader {
  private readonly runtime: CliRuntime;
  private readonly paths: Pick<TeamPaths, 'team' | 'goals'>;
  private readonly config: Pick<KitConfig, 'team' | 'register'>;

  constructor(runtime: CliRuntime, paths: Pick<TeamPaths, 'team' | 'goals'>, config: Pick<KitConfig, 'team' | 'register'>) {
    this.runtime = runtime;
    this.paths = paths;
    this.config = config;
  }

  async read(): Promise<ReadonlySet<string>> {
    if (this.config.register.goals === 'free') {
      return NO_GOAL_TAGS;
    }
    return new Set((await this.all()).keys());
  }

  /**
   * Every goal a task of the team may serve, whatever `register.goals` says, as a goal's rank counts under `free` too.
   * A tag two teams hold reads as the nearest team's: the root's goes first, so each team below overwrites it.
   */
  async all(): Promise<ReadonlyMap<string, Goal>> {
    const files = [...(await this.aboveFiles()), this.paths.goals];
    const reads = await Promise.all(files.map(async (file) => readGoals(await this.runtime.files.read(file))));
    return new Map(reads.flatMap((read) => [...read.goals]));
  }

  /** The goals files of the teams above this one; none for a root team, read without the tree. */
  private async aboveFiles(): Promise<string[]> {
    if (this.config.team?.parent === undefined) {
      return [];
    }
    const { tree, teams } = await loadTree(this.runtime);
    return tree.ancestorsOf(this.paths.team).flatMap((team) => {
      const above = teams.get(team);
      return above === undefined ? [] : [above.kit.paths.goals];
    });
  }
}
