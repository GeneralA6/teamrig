import { join } from 'node:path';
import type { Roster } from '../config/roster.ts';
import type { KitConfig, OtherAreaListing } from '../config/types.ts';
import { listingOverrides } from '../skills/listing.ts';
import { SkillDir } from '../skills/store.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree } from './tree.ts';

/** What a launch adds for the session's skill listing: Claude Code's `--settings` argument, and a note for its start line. */
export interface LaunchListing {
  readonly args: readonly string[];
  /** `; N skills of other areas listed ...`, or empty when every skill is listed in full. */
  readonly note: string;
}

const LISTED: Readonly<Record<OtherAreaListing, string>> = {
  on: 'in full',
  'name-only': 'by name only',
  'user-invocable-only': 'only as /name commands',
  off: 'not at all',
};

/**
 * Writes `<state>/launch/<id>.settings.json` with the `skillOverrides` for the session's skill listing
 * ([skills.otherAreas]) and returns the `--settings` argument naming it; nothing when every skill is listed in full.
 * A skill's area is a session of any team of the kit home sharing this team's skills folder, so another team's skills
 * there are another area's too. A file, not inline JSON, so no shell quoting touches it.
 */
export async function launchListing(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, id: string): Promise<LaunchListing> {
  const otherAreas = config.skills.otherAreas;
  if (otherAreas === 'on') {
    return { args: [], note: '' };
  }
  const { teams } = await loadTree(runtime);
  const sharing = [...teams.values()].filter((team) => team.kit.paths.skills === kit.paths.skills).flatMap((team) => team.roster.ids);
  const skills = await new SkillDir(runtime.files, kit.paths.skills).readAll();
  const overrides = listingOverrides(skills, { session: id, areas: [...new Set([...roster.ids, ...sharing])], sharedPrefix: config.skills.sharedPrefix, otherAreas });
  const count = Object.keys(overrides).length;
  if (count === 0) {
    return { args: [], note: '' };
  }
  const path = join(kit.paths.launchSettings, `${id}.settings.json`);
  await runtime.files.write(path, `${JSON.stringify({ skillOverrides: overrides }, null, 2)}\n`);
  const skillsWord = count === 1 ? 'skill' : 'skills';
  return { args: ['--settings', path], note: `; ${count} ${skillsWord} of other areas listed ${LISTED[otherAreas]} (skills.otherAreas)` };
}
