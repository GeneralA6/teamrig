import { loadConfig } from "../config/load.js";
import { Roster } from "../config/roster.js";
import { ENV, resolveKitHome, teamPaths } from "../core/home.js";
import { ID_PATTERN } from "../core/ids.js";
import { resolveTeam, TEAM_POINTER } from "../core/team.js";
import { RefusedError } from "./runtime.js";
export function rosterOf(kit, config) {
    return new Roster(config, kit.paths.team);
}
/** The id of the session a command line names by id or current name; anything else is refused. */
export function sessionIdOf(roster, text) {
    const found = roster.lookup(text);
    if (!found.ok) {
        throw new RefusedError(found.error);
    }
    return found.id;
}
/**
 * For a filter or a status: the id when the text names a session, and an id no longer on the team as
 * given, so a past session's records stay reachable. Anything else is refused.
 */
export function pastOrPresentIdOf(roster, text) {
    const found = roster.lookup(text);
    if (found.ok) {
        return found.id;
    }
    if (!ID_PATTERN.test(text)) {
        throw new RefusedError(found.error);
    }
    return text;
}
/** The team's folder under the kit home, its config and the paths the config moves. */
export async function openKit(runtime, team) {
    const kitHome = resolveKitHome(runtime.env, runtime.userHome);
    const load = await loadConfig(runtime.files, teamPaths(kitHome, team, runtime.userHome).config);
    const overrides = load.status === 'loaded' ? load.config.paths : {};
    return { load, paths: teamPaths(kitHome, team, runtime.userHome, overrides) };
}
/**
 * Where to look for a team pointer: the given folders in order, then the folder Claude Code started
 * the session in, so a command run from a subfolder or a temp folder still finds its team.
 */
export function teamFolders(env, first) {
    return [...first, env[ENV.claudeProjectDir]].flatMap((folder) => (folder?.trim() ? [folder] : []));
}
/** A command's team: `$TEAMRIG_TEAM`, else the nearest pointer. Without one the command refuses. */
export async function openTeamKit(runtime) {
    const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
    switch (found.kind) {
        case 'none':
            throw new RefusedError(`no team here: set $${ENV.team}, or put ${TEAM_POINTER} {"team": "<id>"} in the project folder`);
        case 'broken':
            throw new RefusedError(`${found.from} ${found.problem}`);
        case 'team':
            return openKit(runtime, found.team);
    }
}
export function issueText(issue) {
    return `${issue.path === '' ? '(top level)' : issue.path}: ${issue.message}`;
}
/**
 * The team config. A config with problems still loads, each bad field on its default: reads go
 * on with a warning, writes are refused until it is fixed. A config from a newer teamrig is read
 * best-effort and never written through.
 */
export function requireConfig(kit, runtime, access) {
    const { load } = kit;
    switch (load.status) {
        case 'missing':
            throw new RefusedError(`no team config at ${load.path}; write one (see the README), then run: teamrig config validate`);
        case 'unreadable':
            throw new RefusedError(`the team config at ${load.path} cannot be read: ${issueText(load.issue)}`);
        case 'loaded':
            break;
    }
    const [first] = load.issues;
    const newer = load.newerVersion === undefined ? undefined : `${load.path} is config version ${load.newerVersion}, from a newer teamrig; update teamrig`;
    if (access === 'write') {
        if (newer !== undefined) {
            throw new RefusedError(`${newer} before writing`);
        }
        if (first !== undefined) {
            throw new RefusedError(`the team config has ${load.issues.length} problem(s) (first: ${issueText(first)}); run: teamrig config validate`);
        }
    }
    if (newer !== undefined) {
        runtime.out.stderr(`WARN ${newer}; reading it best-effort`);
    }
    if (first !== undefined) {
        runtime.out.stderr(`WARN config: ${load.issues.length} problem(s), defaults used (first: ${issueText(first)}); run: teamrig config validate`);
    }
    return load.config;
}
