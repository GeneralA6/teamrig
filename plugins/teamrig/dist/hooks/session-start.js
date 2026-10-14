import { Roster } from "../config/roster.js";
import { ENV, KIT_NAME } from "../core/home.js";
import { renderCorePack, renderSessionContext } from "../rules/pack.js";
/**
 * Who this session is and whom to message. Session names are machine-wide in Claude Code, so the
 * session learns the exact names to use; an unknown value is never echoed, so the lines stay short.
 */
function identityLines(roster, input) {
    const { command, session } = input;
    const lead = roster.holderOf('lead');
    const leadName = lead === undefined ? undefined : roster.nameOf(lead);
    const found = session === undefined ? undefined : roster.lookup(session);
    const names = `\`${command} who\` prints the name to message any session by; message only those names.`;
    if (found === undefined || !found.ok) {
        const why = session === undefined ? `No session is set ($${ENV.session})` : `$${ENV.session} does not name a session on this team`;
        const toLead = leadName === undefined ? '' : ` Message the lead as \`${leadName}\`.`;
        return [`${why}: ask the user which session you are (\`${command} who\` lists them) and pass --session <id> to every \`${command}\` task and inbox command.${toLead}`, names];
    }
    const roles = roster.rolesOf(found.id);
    const held = roles.length === 0 ? '' : `, roles: ${roles.join(', ')}`;
    const you = `You are the \`${found.id}\` session of team \`${input.team}\` (name \`${roster.nameOf(found.id) ?? found.id}\`${held}).`;
    return [lead === found.id || leadName === undefined ? you : `${you} Message the lead as \`${leadName}\`.`, names];
}
/**
 * The SessionStart context: the core rules from the team config, who the session is, and the
 * team's own rules. Without a usable config it says why no rules are loaded, in one line.
 */
export function sessionStartContext(input) {
    const { load, command } = input;
    switch (load.status) {
        case 'missing':
            return `${KIT_NAME} is enabled here but team ${input.team} has no config at ${load.path}, so no team rules are loaded. Write one (see the README), then run: ${command} config validate`;
        case 'unreadable':
            return `${KIT_NAME} cannot read the config of team ${input.team} at ${load.path}, so no team rules are loaded. Run: ${command} config validate`;
        case 'loaded':
            break;
    }
    const notes = identityLines(new Roster(load.config, input.team, input.renames), input);
    // In the core part, so the size budget that may cut the team's rules.md never cuts it.
    if (input.refreshNote !== undefined) {
        notes.push(input.refreshNote);
    }
    if (input.titleNote !== undefined) {
        notes.push(input.titleNote);
    }
    if (load.newerVersion !== undefined) {
        notes.push(`The team config is version ${load.newerVersion}, from a newer ${KIT_NAME}: these rules are read best-effort.`);
    }
    if (load.issues.length > 0) {
        notes.push(`The team config has ${load.issues.length} problem(s), each read as its default; run: ${command} config validate`);
    }
    return renderSessionContext(`${renderCorePack(load.config, command)}\n\n${notes.join('\n')}`, input.teamRules, command);
}
/** The hook's stdout: Claude Code adds `additionalContext` to the session's context. */
export function sessionStartOutput(context) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}
