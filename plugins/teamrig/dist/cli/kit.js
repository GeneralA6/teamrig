import { basename, dirname } from 'node:path';
import { formatConfig, loadConfig } from "../config/load.js";
import { SHIPPED_CONFIG_FORMAT } from "../config/migrate.js";
import { Roster } from "../config/roster.js";
import { parseConfigText } from "../config/text.js";
import { isRecord } from "../core/guards.js";
import { claudeConfigDir, ENV, KIT_NAME, resolveKitHome, teamPaths } from "../core/home.js";
import { ID_PATTERN } from "../core/ids.js";
import { resolveTeam, TEAM_POINTER } from "../core/team.js";
import { TimeZone } from "../core/zone.js";
import { JsonlRenameLog } from "../names/log.js";
import { RefusedError } from "./runtime.js";
import { fileLockOf } from "./file-locks.js";
/** The rename log, its lock and the roster it gives, for recording a rename. */
export function renameDepsOf(runtime, kit, config) {
    const { files, clock } = runtime;
    return {
        log: new JsonlRenameLog(files, kit.paths.renames),
        mutex: fileLockOf(runtime, kit.paths.renamesLock, config.lock),
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
/** The caller's id when it leads the team; anyone else is refused, naming the lead and `what` only the lead does. */
export function leadOnly(roster, caller, what) {
    const by = sessionIdOf(roster, caller);
    const lead = roster.holderOf('lead');
    if (by !== lead) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} ${what}`);
    }
    return by;
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
    const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
    const load = await loadConfig(runtime.files, teamPaths(kitHome, team, claudeDir).config, format.migrations, format.version);
    return { load, paths: teamPaths(kitHome, team, claudeDir, load.status === 'loaded' ? overridesOf(load.config) : {}) };
}
/**
 * Where to look for a team pointer: the given folders in order, then the folder Claude Code started
 * the session in, so a command run from a subfolder or a temp folder still finds its team.
 */
export function teamFolders(env, first) {
    return [...first, env[ENV.claudeProjectDir]].flatMap((folder) => (folder?.trim() ? [folder] : []));
}
/** A command's team: `$TEAMRIG_TEAM`, else the nearest pointer. Without one the command refuses. */
export async function findTeam(runtime) {
    const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
    switch (found.kind) {
        case 'none':
            throw new RefusedError(`no team here: create one with ${KIT_NAME} team create <team> --sessions <id,id>, set $${ENV.team}, or put ${TEAM_POINTER} {"team": "<id>"} in the project folder`);
        case 'broken':
            throw new RefusedError(`${found.from} ${found.problem}`);
        case 'team':
            return { team: found.team, from: found.from };
    }
}
/**
 * The team's project folder, where its CLAUDE.md and rule files sit: `team.project`, else the folder of its pointer
 * file; for a team named by `$TEAMRIG_TEAM` alone, the folder Claude Code started the session in, else the working folder.
 */
export async function projectFolder(runtime, config) {
    const { from } = await findTeam(runtime);
    return teamProjectOf(config, from) ?? teamFolders(runtime.env, [])[0] ?? runtime.cwd;
}
/**
 * The team's project folder by its config and the pointer it was found by (`FoundTeam.from`): `team.project`,
 * else the pointer's folder; none for a team named by `$TEAMRIG_TEAM` alone.
 */
export function teamProjectOf(config, from) {
    return config.team?.project ?? (basename(from) === TEAM_POINTER ? dirname(from) : undefined);
}
/** The kit of a command's team (see `findTeam`). */
export async function openTeamKit(runtime) {
    return openKit(runtime, (await findTeam(runtime)).team);
}
export function issueText(issue) {
    return `${issue.path === '' ? '(top level)' : issue.path}: ${issue.message}`;
}
/**
 * The config a command is about to write, read back as every later command will read it; refused, so nothing
 * is written, when it would not load or would load with a problem.
 */
export function checkedNextConfig(json) {
    const next = parseConfigText(formatConfig(json));
    if (next.status !== 'loaded') {
        throw new RefusedError(`the new config cannot be read: ${issueText(next.issue)}`);
    }
    const [problem] = next.issues;
    if (problem !== undefined) {
        throw new RefusedError(`nothing written: ${issueText(problem)}`);
    }
    return next.config;
}
/** The zone the team's people read and type times in: the config's `timeZone`, else the machine's. */
export function teamZone(config, runtime) {
    return TimeZone.resolve(config.timeZone, runtime.timeZone);
}
/** The clock the start rules are read on: this moment, and the machine's zone a team without `timeZone` reads them in. */
export function rulesClockOf(runtime) {
    return { now: new Date(runtime.clock.now()), machineZone: runtime.timeZone };
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
            throw new RefusedError(`no team config at ${load.path}; create it with: ${KIT_NAME} team create ${kit.paths.team} --sessions <id,id>`);
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
/** The config file's own JSON, not the copy migrated in memory, so nothing else in it changes, its version included. */
export async function configFileJson(runtime, path) {
    const text = await runtime.files.read(path);
    let raw;
    try {
        raw = text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        raw = undefined;
    }
    if (!isRecord(raw)) {
        throw new RefusedError(`${path} changed while it was read; run the command again`);
    }
    return raw;
}
