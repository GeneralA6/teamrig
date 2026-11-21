import type { TeamPaths } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { goalsBody, type HeldGoals } from '../../interface/index.ts';
import { readGoals, type GoalsRead } from '../../register/goals.ts';
import { teamsFolderOf, type KitTree } from '../tree.ts';
import { servedPathOf, skippedOf, stampsOf, type DocumentSource, type ReadScope } from './read-source.ts';

/** A goals file a task of the team may serve a goal of, and the team that holds it. */
type Holder = Pick<TeamPaths, 'team' | 'home' | 'goals'>;

/**
 * `goals`: the goals a task of the team may serve, which are its own and those of every team above it, the nearer
 * team's where two hold a tag, as `teamrig add --goal` and the plan's ranking read them. A team beside or below
 * the asked one is never read. It reads the tree's configs (who is above whom, the secret shapes) and those goals
 * files, and its revision covers each of them; `--owner` does not narrow it, as a goal is no session's.
 */
export function goalsSource(scope: ReadScope): DocumentSource {
  const { runtime, kit, config } = scope;
  return {
    async parts() {
      const loaded = await scope.tree();
      const configs = [...[...loaded.teams.values()].map((other) => other.kit.load.path), ...[...loaded.leftOut.values()].map((load) => load.path)];
      return {
        document: 'goals',
        args: [['team', kit.paths.team]],
        stamps: [
          // A team folder added or removed moves no file the tree read: the folder's own listing tells.
          (await runtime.files.list(teamsFolderOf(runtime))).join(','),
          ...(await stampsOf(runtime, configs)),
          ...(await stampsOf(runtime, holdersOf(loaded, kit.paths).map((holder) => holder.goals))),
        ],
      };
    },
    async build() {
      const held: HeldGoals[] = [];
      const problems: string[] = [];
      for (const holder of holdersOf(await scope.tree(), kit.paths)) {
        const read = readGoals(await runtime.files.read(holder.goals));
        held.push({ team: holder.team, goals: read.goals.values() });
        problems.push(...leftOutOf(holder, read));
      }
      return { body: goalsBody({ held, shapes: new SecretScanner(config.register.secretPatterns) }), problems };
    },
  };
}

/** The teams above `own` that the tree loaded, the root first, then `own` itself, read from the kit the run opened. */
function holdersOf(loaded: KitTree, own: Holder): Holder[] {
  const above = loaded.tree.ancestorsOf(own.team).flatMap((team) => {
    const found = loaded.teams.get(team);
    return found === undefined ? [] : [found.kit.paths];
  });
  return [...above, own];
}

/** What a goals file's read left out, a fixed line per kind: the file's served name and a count, never a line's own text. */
function leftOutOf(holder: Holder, read: GoalsRead): string[] {
  const ignored = read.ignored > 0 ? [`${servedPathOf(holder, holder.goals)}: ${read.ignored} record(s) of no goal left out`] : [];
  return [...skippedOf(holder, holder.goals, read), ...ignored];
}
