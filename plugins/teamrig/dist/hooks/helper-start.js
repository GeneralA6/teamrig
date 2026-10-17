import { Roster } from "../config/roster.js";
import { isRecord, stringField } from "../core/guards.js";
import { ENV } from "../core/home.js";
import { renderCorePack, renderSessionContext } from "../rules/pack.js";
import { shellNote, unloadedContext } from "./session-start.js";
/** An agent type safe to print in the context: a name such as `general-purpose` or `plugin:reviewer`. */
const AGENT_TYPE = /^[\w.:-]{1,80}$/;
/**
 * The helper a hook payload comes from. Claude Code puts `agent_id` and `agent_type` on the hooks that
 * run inside a helper (its SubagentStart, its tool calls, a compaction of its context) and on no hook of
 * the session itself, while `session_id` stays the session's. Undefined for a session's own hook.
 */
export function helperOf(payload) {
    if (!isRecord(payload)) {
        return undefined;
    }
    const agentId = stringField(payload, 'agent_id');
    if (agentId === undefined || agentId === '') {
        return undefined;
    }
    const type = stringField(payload, 'agent_type');
    return { agentId, agentType: type !== undefined && AGENT_TYPE.test(type) ? type : undefined };
}
/**
 * Whose helper this is and what it leaves to that session. Never "You are the X session": the helper
 * would take the session's identity and set its tasks or message its peers.
 */
function helperLine(roster, input) {
    const { command, agentType } = input;
    const kind = agentType === undefined ? 'a helper' : `a helper (\`${agentType}\`)`;
    const found = input.session === undefined ? undefined : roster.lookup(input.session);
    const known = found !== undefined && found.ok ? found.id : undefined;
    const parent = known === undefined ? 'a session' : `the \`${known}\` session`;
    const name = known === undefined ? '' : ` (name \`${roster.nameOf(known) ?? known}\`)`;
    const duty = `The rules above bind you as they bind it, but your brief is your task: leave \`${command} start\`, task statuses, register entries, inbox lines and messages to it unless your brief asks for them, and return what it needs.`;
    const pass = known === undefined || input.sessionInEnv ? '' : ` $${ENV.session} is not set here, so pass --session ${known} to any \`${command}\` command your brief asks for.`;
    return `You are ${kind} of ${parent} of team \`${input.team}\`${name}. ${duty}${pass}${shellNote(input)}`;
}
/**
 * The context a helper starts with (a SubagentStart, or a compaction inside the helper): the team's core
 * rules and its rules.md, as its session gets them, then whose helper it is. Nothing only a session acts
 * on: no lead lines, live tasks, verify list, refresh, title or model notes. Without a usable config it says
 * why no rules are loaded, in one line.
 */
export function helperStartContext(input) {
    const { load, command } = input;
    if (load.status !== 'loaded') {
        return unloadedContext(input.team, load, command);
    }
    const roster = new Roster(load.config, input.team, input.renames);
    const core = renderCorePack(load.config, command, input.platform);
    return renderSessionContext(`${core}\n\n${helperLine(roster, input)}`, input.teamRules, command);
}
/** The SubagentStart hook's stdout: Claude Code adds `additionalContext` to the helper's context. */
export function subagentStartOutput(context) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } });
}
