import { Roster } from "../config/roster.js";
import { formatAddress } from "../core/address.js";
import { ENV, KIT_NAME } from "../core/home.js";
import { renderCorePack, renderLeadRules, renderSessionContext } from "../rules/pack.js";
/** Whether the session the input names holds the team's lead role. */
function isLeadSession(roster, session) {
    const found = session === undefined ? undefined : roster.lookup(session);
    return found !== undefined && found.ok && found.id === roster.holderOf('lead');
}
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
    const isLead = isLeadSession(roster, session);
    const tree = input.tree === undefined ? [] : [treeLine(input.tree, input, isLead)];
    if (found === undefined || !found.ok) {
        const why = session === undefined ? `No session is set ($${ENV.session})` : `$${ENV.session} does not name a session on this team`;
        const toLead = leadName === undefined ? '' : ` Message the lead as \`${leadName}\`.`;
        return [`${why}: ask the user which session you are (\`${command} who\` lists them) and pass --session <id> to every \`${command}\` task and inbox command.${toLead}`, names, ...tree];
    }
    const roles = roster.rolesOf(found.id);
    const held = roles.length === 0 ? '' : `, roles: ${roles.join(', ')}`;
    const you = `You are the \`${found.id}\` session of team \`${input.team}\` (name \`${roster.nameOf(found.id) ?? found.id}\`${held}).`;
    const pass = input.sessionInEnv ? '' : ` $${ENV.session} is not set here, so pass --session ${found.id} to every \`${command}\` task and inbox command.`;
    return [lead === found.id || leadName === undefined ? `${you}${pass}` : `${you}${pass} Message the lead as \`${leadName}\`.`, names, ...tree];
}
/**
 * How a session of a team in a tree escalates: a member through its own lead; a sub-team's lead to
 * its parent lead, up to the root's lead, the only one the user talks to, and splits the tasks that
 * lead hands it among its own sessions. A lead with sub-teams also learns how to read their registers
 * and hand them tasks.
 */
function treeLine(place, input, isLead) {
    const { team, command } = input;
    if (!isLead) {
        return `Team \`${team}\` is part of the tree of teams under \`${place.root}\`: take anything outside your team to your lead, never to another team's sessions (\`${command} inbox add\` refuses a note to them).`;
    }
    const { parentLead } = place;
    const up = parentLead === undefined
        ? `Team \`${team}\` is the root of a tree of teams: you are the one lead the user talks to, and the sub-team leads bring you their owner decisions.`
        : `Team \`${team}\` is a sub-team of \`${parentLead.team}\` in the tree under \`${place.root}\`: the user talks only to the root team's lead.` +
            ` Take owner decisions and cross-team issues to your parent lead \`${formatAddress(parentLead)}\` (name \`${parentLead.name}\`, inbox: \`${command} inbox add --to ${formatAddress(parentLead)}\`), who carries them up.` +
            ` Split each task it hands you among your sessions: \`${command} add --owner <id>\` gives one its part, and \`${command} open <id>\` starts it.`;
    const down = place.children.length === 0
        ? ''
        : ` Your sub-teams (${place.children.join(', ')}) answer to you: \`${command} list|check|plan --tree\` reads their registers, and \`${command} add --team <team>\` hands its lead a task.`;
    return up + down;
}
/**
 * The SessionStart context: the core rules from the team config, the lead's own lines for the lead, who the
 * session is, where its team sits in a tree of teams, and the team's own rules. Without a usable config it says why no rules are loaded, in one line.
 */
export function sessionStartContext(input) {
    const { load, command } = input;
    switch (load.status) {
        case 'missing':
            return `${KIT_NAME} is enabled here but team ${input.team} has no config at ${load.path}, so no team rules are loaded. Create it with: ${command} team create ${input.team} --sessions <id,id>`;
        case 'unreadable':
            return `${KIT_NAME} cannot read the config of team ${input.team} at ${load.path}, so no team rules are loaded. Run: ${command} config validate`;
        case 'loaded':
            break;
    }
    const roster = new Roster(load.config, input.team, input.renames);
    const notes = identityLines(roster, input);
    // In the core part, so the size budget that may cut the team's rules.md never cuts it.
    if (input.refreshNote !== undefined) {
        notes.push(input.refreshNote);
    }
    if (input.titleNote !== undefined) {
        notes.push(input.titleNote);
    }
    if (input.modelNote !== undefined) {
        notes.push(input.modelNote);
    }
    if (input.verifyNote !== undefined) {
        notes.push(input.verifyNote);
    }
    if (load.newerVersion !== undefined) {
        notes.push(`The team config is version ${load.newerVersion}, from a newer ${KIT_NAME}: these rules are read best-effort.`);
    }
    if (load.issues.length > 0) {
        notes.push(`The team config has ${load.issues.length} problem(s), each read as its default; run: ${command} config validate`);
    }
    const core = renderCorePack(load.config, command, input.platform);
    const rules = isLeadSession(roster, input.session) ? `${core}\n\n${renderLeadRules(load.config, command)}` : core;
    return renderSessionContext(`${rules}\n\n${notes.join('\n')}`, input.teamRules, command);
}
/**
 * The hook's stdout: Claude Code adds `additionalContext` to the session's context and shows the
 * notices, when there are any, to the user as one `systemMessage`: the user alone can change the model
 * or the effort, or install what teamrig lacks.
 */
export function sessionStartOutput(context, notices = []) {
    const hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };
    const shown = notices.filter((notice) => notice !== undefined);
    return JSON.stringify(shown.length === 0 ? { hookSpecificOutput } : { systemMessage: shown.join('\n'), hookSpecificOutput });
}
