import { Roster } from "../../config/roster.js";
import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { helperOf, helperStartContext, subagentStartOutput } from "../../hooks/helper-start.js";
import { JsonlRenameLog } from "../../names/log.js";
import { noPositionals } from "../args.js";
import { openKit, rulesClockOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { envSession, parseJson, sessionTeam, startSessionOf } from "./hook-input.js";
/**
 * A helper's start context, read-only: the rename log, the team's rules.md and the session that started
 * it, found as that session's own start finds it (`$TEAMRIG_SESSION`, else the area its Claude Code
 * session read its inbox as: a helper's hooks carry the session's id). It binds no tab, renames nothing
 * and starts no refresh: those belong to the session.
 */
export async function helperContextOf(runtime, kit, payload, agentType) {
    const base = { team: kit.paths.team, agentType, platform: runtime.platform, clock: rulesClockOf(runtime), command: KIT_NAME };
    const { load } = kit;
    if (load.status !== 'loaded') {
        return helperStartContext({ ...base, load, teamRules: undefined, renames: [], session: undefined, sessionInEnv: false });
    }
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    const roster = new Roster(load.config, kit.paths.team, renames);
    const text = await runtime.files.read(kit.paths.teamRules);
    const fromEnv = envSession(runtime);
    const input = {
        ...base,
        load,
        teamRules: text === undefined ? undefined : { path: kit.paths.teamRules, text },
        renames,
        session: fromEnv ?? (await startSessionOf(runtime, kit, roster, payload)),
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
    const payload = parseJson(await runtime.readStdin());
    const found = await sessionTeam(payload, runtime);
    switch (found.kind) {
        case 'none':
            return EXIT.ok;
        case 'broken':
            runtime.out.stdout(subagentStartOutput(`${KIT_NAME}: no team, so no team rules: ${found.from} ${found.problem}`));
            return EXIT.ok;
        case 'team':
            break;
    }
    const context = await openKit(runtime, found.team)
        .then((kit) => helperContextOf(runtime, kit, payload, helperOf(payload)?.agentType))
        .catch((error) => `${KIT_NAME} could not load the rules of team ${found.team}: ${errorMessage(error)}`);
    runtime.out.stdout(subagentStartOutput(context));
    return EXIT.ok;
}
