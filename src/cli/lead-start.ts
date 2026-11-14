import { LeadTree } from '../config/lead-tree.ts';
import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { LeadStart } from '../doctor/doctor.ts';
import { sessionStartContext, type SessionStartInput } from '../hooks/session-start.ts';
import type { Rename } from '../names/rename.ts';
import { CONTEXT_MAX_CHARS } from '../rules/pack.ts';
import { blockStartOf, liveTasksNoteOf } from './commands/live-tasks.ts';
import { rulesClockOf, teamZone, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { keptRulesAboveOf, readTeamRules } from './team-rules.ts';
import type { KitTree } from './tree.ts';

/**
 * The lead's start as the SessionStart hook gives it after a compaction, with its live tasks block read from the
 * register now, for `doctor` (T2231): the lead's start holds the most of any session's (its lines, the resets), so a
 * team whose lead start stays inside the cap keeps every session's there. Its length, the room it leaves the team
 * rules files beside everything else at its shortest (the same start with no rules files and the live block's
 * shortest form, as `fitContext` places the rules files before a long note's longer forms), and each file with text
 * it shows only as a pointer: a file shown in full appears in it word for word. The other notes (verify rows, the
 * model line) come only on some starts, so they are left out.
 */
export async function readLeadStart(runtime: CliRuntime, kit: Kit, kitTree: KitTree, config: KitConfig, renames: readonly Rename[]): Promise<LeadStart> {
  const lead = new LeadTree(config).lead;
  const team = kit.paths.team;
  const teamRules = await readTeamRules(runtime, kit, kitTree);
  const live = await liveTasksNoteOf(runtime, kit.paths, config, lead, teamZone(config, runtime), await blockStartOf(runtime, kit, config, lead));
  const input: SessionStartInput = {
    team,
    load: kit.load,
    teamRules,
    keptRulesAbove: keptRulesAboveOf(kit, kitTree),
    renames,
    titleNote: undefined,
    refreshNote: undefined,
    liveTasksNote: live,
    modelNote: undefined,
    verifyNote: undefined,
    duplicateNote: undefined,
    worktreeNote: undefined,
    session: lead,
    sessionInEnv: true,
    platform: runtime.platform,
    clock: rulesClockOf(runtime),
    tree: kitTree.tree.placeOf(team),
    command: KIT_NAME,
  };
  const text = sessionStartContext(input);
  const fixed = sessionStartContext({ ...input, teamRules: [], liveTasksNote: { text: live.pointer, pointer: live.pointer } });
  const pointed = teamRules.filter((rules) => rules.text.trim() !== '' && !text.includes(rules.text.trim())).map((rules) => rules.path);
  return { lead, chars: text.length, room: CONTEXT_MAX_CHARS - fixed.length, pointed };
}
