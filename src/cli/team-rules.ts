import type { KeptRule, TeamRules } from '../rules/pack.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree, type KitTree } from './tree.ts';

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

/**
 * The kept local rules [ruleConflicts] of each team above `kit`'s, root first and parent last, each tagged with its
 * team (a team the tree did not load is left out). Its own team's stay in its config: `rules keep` and `forget` write
 * that config back, so these are never merged into it.
 */
export function keptRulesAboveOf(kit: Kit, kitTree: KitTree): KeptRule[] {
  return kitTree.tree
    .ancestorsOf(kit.paths.team)
    .flatMap((ancestor) =>
      (kitTree.teams.get(ancestor)?.config.ruleConflicts ?? []).map((kept): KeptRule => ({ ...kept, team: ancestor })),
    );
}

/** The paths of `teamRulesFilesOf`, existing or not, for the scans that look for them. */
export async function teamRulesPathsOf(runtime: CliRuntime, kit: Kit): Promise<string[]> {
  return teamRulesFilesOf(kit, await loadTree(runtime)).map((file) => file.path);
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
