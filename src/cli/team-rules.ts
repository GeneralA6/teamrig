import type { TeamRules } from '../rules/pack.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import type { KitTree } from './tree.ts';

/** A team rules file a session of `kit`'s team is shown at start: whose it is and where. */
export type TeamRulesFile = Pick<TeamRules, 'ancestor' | 'path'>;

/**
 * The rules.md files a session of `kit`'s team is shown at start: each team above its own, root first and parent
 * last (a team the tree did not load is left out), then its own team's.
 */
export function teamRulesFilesOf(kit: Kit, kitTree: KitTree): TeamRulesFile[] {
  const above = kitTree.tree.ancestorsOf(kit.paths.team).flatMap((ancestor): TeamRulesFile[] => {
    const team = kitTree.teams.get(ancestor);
    return team === undefined ? [] : [{ ancestor, path: team.kit.paths.teamRules }];
  });
  return [...above, { ancestor: undefined, path: kit.paths.teamRules }];
}

/** The team rules files of `teamRulesFilesOf` that exist, read in its order. */
export async function readTeamRules(runtime: CliRuntime, kit: Kit, kitTree: KitTree): Promise<TeamRules[]> {
  const rules: TeamRules[] = [];
  for (const file of teamRulesFilesOf(kit, kitTree)) {
    const text = await runtime.files.read(file.path);
    if (text !== undefined) {
      rules.push({ ...file, text });
    }
  }
  return rules;
}
