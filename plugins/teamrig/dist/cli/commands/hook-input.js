import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord, stringField } from "../../core/guards.js";
import { claudeConfigDir, claudeTempDir, ENV } from "../../core/home.js";
import { resolveTeam } from "../../core/team.js";
import { OwnPaths, TeamFolders } from "../../hooks/lead-boundary.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { indexMarks } from "../../inbox/marks.js";
import { openKit, rosterOf, teamFolders } from "../kit.js";
import { inboxDepsOf } from "./inbox.js";
/** A hook's stdin as JSON; undefined when it is not JSON, which every hook treats as nothing to do. */
export function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/**
 * The team a session's hooks run for: `$TEAMRIG_TEAM`, else the nearest pointer above the folder the
 * session started in (`$CLAUDE_PROJECT_DIR`), then the payload's folder. The payload's `cwd` follows
 * a `cd`, so walking it first would let a tab that moved into another team's project read, and bind
 * to, that team's sessions. The push guard keeps `hookTeam`: a push belongs to the folder it runs in.
 */
export function sessionTeam(payload, runtime) {
    const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.env[ENV.claudeProjectDir], cwd, runtime.cwd]));
}
/** `$TEAMRIG_SESSION` as Claude Code passed it to the hook; undefined when unset or blank. */
export function envSession(runtime) {
    const session = runtime.env[ENV.session]?.trim();
    return session === '' ? undefined : session;
}
/**
 * The team session a hook runs for: `$TEAMRIG_SESSION` when it is set (an id or any name the
 * session has had), else the area this Claude Code session last read its inbox as.
 */
export async function teamSessionOf(runtime, kit, roster, claudeSession) {
    const session = envSession(runtime);
    if (session !== undefined) {
        const found = roster.lookup(session);
        return found.ok ? found.id : undefined;
    }
    return markedSessionOf(runtime, kit, roster, claudeSession);
}
/**
 * The area this Claude Code session last read its inbox as, or was bound to by its title, when it is
 * on the roster. It is how a tab started without `$TEAMRIG_SESSION`, such as the one that set the team
 * up, stays its session.
 */
export async function markedSessionOf(runtime, kit, roster, claudeSession) {
    if (claudeSession === null) {
        return undefined;
    }
    const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
    const area = indexMarks(marks).areaBySession.get(claudeSession);
    return area !== undefined && roster.ids.includes(area) ? area : undefined;
}
/**
 * `markedSessionOf` for a start's context (a session's or its helper's), which must always load: a failed
 * read means no session. A helper's hooks carry the session id of the session that started it.
 */
export async function startSessionOf(runtime, kit, roster, payload) {
    try {
        return await markedSessionOf(runtime, kit, roster, sessionIdOf(payload));
    }
    catch {
        return undefined;
    }
}
/** The hook payload's team; undefined outside a team or without a loaded config. */
export async function teamScopeOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    if (found.kind !== 'team') {
        return undefined;
    }
    const kit = await openKit(runtime, found.team);
    return kit.load.status === 'loaded' ? { kit, config: kit.load.config } : undefined;
}
/** The team session of a payload in `team`; undefined when the tab is no session of it. */
export async function sessionScopeOf(runtime, team, payload) {
    const roster = await rosterOf(runtime, team.kit, team.config);
    const id = await teamSessionOf(runtime, team.kit, roster, sessionIdOf(payload));
    return id === undefined ? undefined : { ...team, roster, id };
}
/** The hook payload's team session (Stop, helper gate, the mod's refresh checks); undefined outside a team, without a loaded config or without a session. */
export async function hookScopeOf(runtime, payload) {
    const team = await teamScopeOf(runtime, payload);
    return team === undefined ? undefined : sessionScopeOf(runtime, team, payload);
}
/**
 * Where the lead's calls land in this team. Its own paths: its teamrig folder, Claude Code's memory folders, its
 * session scratchpads (notes and command input it keeps for itself, never work to hand off) and
 * `leadBoundary.ownPaths`. In the teamrig folder, a search outside the config, the rules, the register's state and
 * the places named for the lead is research (T736).
 */
export function leadPathsOf(runtime, kit, config) {
    const memory = join(claudeConfigDir(runtime.env, runtime.userHome), 'projects', '*', 'memory');
    const scratchpads = join(claudeTempDir(runtime.env, tmpdir()), 'claude', '*', '*', 'scratchpad');
    const { home, config: configFile, teamRules, state } = kit.paths;
    return {
        own: new OwnPaths([home, memory, scratchpads, ...config.leadBoundary.ownPaths], runtime.userHome),
        team: new TeamFolders({ home, own: [configFile, teamRules, state], lead: config.roles.lead, sessions: config.sessions }, runtime.userHome),
    };
}
