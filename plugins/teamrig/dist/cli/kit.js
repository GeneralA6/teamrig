import { loadConfig } from "../config/load.js";
import { SHIPPED_CONFIG_FORMAT } from "../config/migrate.js";
import { Roster } from "../config/roster.js";
import { ENV, resolveKitHome, teamPaths } from "../core/home.js";
import { ID_PATTERN } from "../core/ids.js";
import { FileLock } from "../core/lock.js";
import { resolveTeam, TEAM_POINTER } from "../core/team.js";
import { JsonlRenameLog } from "../names/log.js";
import { RefusedError } from "./runtime.js";
/** The rename log, its lock and the roster it gives, for recording a rename. */
export function renameDepsOf(runtime, kit, config) {
    const { files, clock, sleep, pid } = runtime;
    return {
        log: new JsonlRenameLog(files, kit.paths.renames),
        mutex: new FileLock(kit.paths.renamesLock, config.lock, { files, clock, sleep, pid }),
        clock,
        rosterOf: (renames) => new Roster(config, kit.paths.team, renames),
    };
}
/**
 * The team's sessions with every rename applied, so a name any session has had resolves. A damaged
 * or newer line in the rename log is skipped here; `doctor` reports it.
 */
export async function rosterOf(runtime, kit, config) {
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    return new Roster(config, kit.paths.team, renames);
}
/** The id of the session a command line names by id, current name or former name; anything else is refused. */
export function sessionIdOf(roster, text) {
    const found = roster.lookup(text);
    if (!found.ok) {
        throw new RefusedError(found.error);
    }
    return found.id;
}
/**
 * For a filter or a status: the id when the text names a session, and the id of a session no longer
 * on the team, given as its id or a name it had, so a past session's records stay reachable.
 * Anything else is refused.
 */
export function pastOrPresentIdOf(roster, text) {
    const found = roster.lookup(text);
    if (found.ok) {
        return found.id;
    }
    if (found.pastId !== undefined) {
        return found.pastId;
    }
    if (!ID_PATTERN.test(text)) {
        throw new RefusedError(found.error);
    }
    return text;
}
/** The folders a config moves: its `paths`, and the handover folder from `refresh`. */
function overridesOf(config) {
    const { handoverDir } = config.refresh;
    return { ...config.paths, ...(handoverDir === undefined ? {} : { handover: handoverDir }) };
}
/** The team's folder under the kit home, its config and the paths the config moves. */
export async function openKit(runtime, team) {
    const kitHome = resolveKitHome(runtime.env, runtime.userHome);
    const format = runtime.configFormat ?? SHIPPED_CONFIG_FORMAT;
    const load = await loadConfig(runtime.files, teamPaths(kitHome, team, runtime.userHome).config, format.migrations, format.version);
    return { load, paths: teamPaths(kitHome, team, runtime.userHome, load.status === 'loaded' ? overridesOf(load.config) : {}) };
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
