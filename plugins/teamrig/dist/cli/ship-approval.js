import { LeadTree } from "../config/lead-tree.js";
import { formatAddress } from "../core/address.js";
import { JsonlEventLog } from "../register/store.js";
import { openKit, rosterOf, sessionIdOf } from "./kit.js";
import { RefusedError } from "./runtime.js";
import { tabSessionOf } from "./tab-session.js";
import { leadAboveOf } from "./tree.js";
/**
 * The merge standing of `callerText` (an id or a name, from `$TEAMRIG_SESSION`) on team `team` for task `taskId`.
 * Refused when the team's config does not load, the caller is no session of the team, or the caller is a child team's
 * lead whose parent team has no config to name who approves it.
 */
export async function mergeStandingOf(reader, team, callerText, taskId) {
    const kit = await openKit(reader, team);
    if (kit.load.status !== 'loaded') {
        throw new RefusedError(`team ${team}'s config at ${kit.load.path} is ${kit.load.status}: the merge cannot tell who approves it`);
    }
    const { config } = kit.load;
    const caller = sessionIdOf(await rosterOf(reader, kit, config), callerText);
    const { state } = await new JsonlEventLog(reader.files, kit.paths.events).read();
    return { caller, task: state.tasks.get(taskId), approvers: await approversOf(reader, team, config, caller) };
}
/**
 * The session a merge runs for (T2984, security condition C4): the one session of team `team` that the merging Claude
 * Code tab `claudeSession` is bound to (`tabSessionOf`), which must be the one `callerText` (`$TEAMRIG_SESSION`) names,
 * so a typed name moves no merge to another session's task. Refused when the config does not load or the tab is not
 * bound to that session alone.
 */
export async function tabCallerOf(reader, team, claudeSession, callerText) {
    const kit = await openKit(reader, team);
    if (kit.load.status !== 'loaded') {
        throw new RefusedError(`team ${team}'s config at ${kit.load.path} is ${kit.load.status}: the merge cannot tell which session its tab is`);
    }
    const roster = await rosterOf(reader, kit, kit.load.config);
    const bound = await tabSessionOf(reader.files, kit.paths.inboxMarks, roster, claudeSession, callerText);
    if (bound === undefined) {
        throw new RefusedError(`this Claude Code tab is not bound to ${callerText} alone: a merge runs from the merging session's own tab, whose every inbox mark names that session (a tab that read another session's inbox merges nothing)`);
    }
    return bound;
}
async function approversOf(reader, team, config, caller) {
    if (caller !== config.roles.lead) {
        return new LeadTree(config).chainOf(caller);
    }
    const parent = config.team?.parent;
    if (parent === undefined) {
        return [];
    }
    const above = await leadAboveOf(reader, team, config);
    if (above === undefined) {
        throw new RefusedError(`team ${parent}, the parent team, has no config to name its lead, who approves the merges of ${team}'s lead`);
    }
    return [formatAddress(above)];
}
