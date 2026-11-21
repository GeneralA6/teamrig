import { Roster } from "../../config/roster.js";
import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { helperOf, helperStartContext } from "../../hooks/helper-start.js";
import { JsonlRenameLog } from "../../names/log.js";
import { noPositionals } from "../args.js";
import { openKit, rulesClockOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { keptRulesAboveOf, readTeamRules } from "../team-rules.js";
import { loadTree } from "../tree.js";
import { envSession, readHookInput, sessionTeam, startSessionOf, writeReply } from "./hook-input.js";
/**
 * A helper's start context, read-only: the rename log, the rules.md of its team and of each team above
 * it, and the session that started it, found as that session's own start finds it (`$TEAMRIG_SESSION`, else the area its Claude Code
 * session read its inbox as: a helper's hooks carry the session's id). It binds no tab, renames nothing
 * and starts no refresh: those belong to the session. `hostSession` is that id, as the hook event names it.
 */
export async function helperContextOf(runtime, kit, hostSession, agentType) {
    const base = { team: kit.paths.team, agentType, platform: runtime.platform, clock: rulesClockOf(runtime), command: KIT_NAME };
    const { load } = kit;
    if (load.status !== 'loaded') {
        return helperStartContext({ ...base, load, teamRules: [], keptRulesAbove: [], renames: [], session: undefined, sessionInEnv: false });
    }
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    const roster = new Roster(load.config, kit.paths.team, renames);
    const fromEnv = envSession(runtime);
    const kitTree = await loadTree(runtime);
    const input = {
        ...base,
        load,
        teamRules: await readTeamRules(runtime, kit, kitTree),
        keptRulesAbove: keptRulesAboveOf(kit, kitTree),
        renames,
        session: fromEnv ?? (await startSessionOf(runtime, kit, roster, hostSession)),
        sessionInEnv: fromEnv !== undefined,
    };
    return helperStartContext(input);
}
/**
 * SubagentStart: gives a helper the team's rules in a helper's words (hooks/helper-start.ts), since Claude
 * Code starts a helper with the CLAUDE.md files but not the session's SessionStart context. Outside a team's
 * projects it prints nothing; it never refuses (a refusal would fail the helper's launch), and a failed read
 * says why the rules are missing instead of leaving the helper without a word.
 */
export async function subagentStart(args, runtime) {
    noPositionals(args);
    const { event } = await readHookInput(runtime);
    const found = await sessionTeam(event?.cwd, runtime);
    switch (found.kind) {
        case 'none':
            return EXIT.ok;
        case 'broken':
            writeReply(runtime, 'helper-start', { context: `${KIT_NAME}: no team, so no team rules: ${found.from} ${found.problem}` });
            return EXIT.ok;
        case 'team':
            break;
    }
    const context = await openKit(runtime, found.team)
        .then((kit) => helperContextOf(runtime, kit, event?.session, helperOf(event?.helper)?.agentType))
        .catch((error) => `${KIT_NAME} could not load the rules of team ${found.team}: ${errorMessage(error)}`);
    writeReply(runtime, 'helper-start', { context });
    return EXIT.ok;
}
