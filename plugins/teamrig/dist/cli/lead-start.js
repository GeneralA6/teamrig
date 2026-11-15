import { LeadTree } from "../config/lead-tree.js";
import { KIT_NAME } from "../core/home.js";
import { sessionStartContext } from "../hooks/session-start.js";
import { CONTEXT_MAX_CHARS } from "../rules/pack.js";
import { blockStartOf, liveTasksNoteOf } from "./commands/live-tasks.js";
import { rulesClockOf, teamZone } from "./kit.js";
import { keptRulesAboveOf, readTeamRules } from "./team-rules.js";
/**
 * The lead's start as the SessionStart hook gives it after a compaction, with its live tasks block read from the
 * register now, for `doctor` (T2231): the lead's start holds the most of any session's (its lines, the resets), so a
 * team whose lead start stays inside the cap keeps every session's there. Its length, the room it leaves the team
 * rules files beside everything else at its shortest (the same start with no rules files and the live block's
 * shortest form, as `fitContext` places the rules files before a long note's longer forms), and each file with text
 * it shows only as a pointer: a file shown in full appears in it word for word. The other notes (verify rows, the
 * model line) come only on some starts, so they are left out.
 */
export async function readLeadStart(runtime, kit, kitTree, config, renames) {
    const lead = new LeadTree(config).lead;
    const team = kit.paths.team;
    const teamRules = await readTeamRules(runtime, kit, kitTree);
    const live = await liveTasksNoteOf(runtime, kit.paths, config, lead, teamZone(config, runtime), await blockStartOf(runtime, kit, config, lead));
    const input = {
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
