import { loadConfig, type ConfigLoad } from '../config/load.ts';
import { SHIPPED_CONFIG_FORMAT } from '../config/migrate.ts';
import type { ConfigIssue } from '../config/reader.ts';
import { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { ENV, resolveKitHome, teamPaths, type Env, type TeamPaths } from '../core/home.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { resolveTeam, TEAM_POINTER } from '../core/team.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

export interface Kit {
  readonly paths: TeamPaths;
  readonly load: ConfigLoad;
}

export function rosterOf(kit: Kit, config: KitConfig): Roster {
  return new Roster(config, kit.paths.team);
}

/** The id of the session a command line names by id or current name; anything else is refused. */
export function sessionIdOf(roster: Roster, text: string): string {
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
export function pastOrPresentIdOf(roster: Roster, text: string): string {
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
export async function openKit(runtime: CliRuntime, team: string): Promise<Kit> {
  const kitHome = resolveKitHome(runtime.env, runtime.userHome);
  const format = runtime.configFormat ?? SHIPPED_CONFIG_FORMAT;
  const load = await loadConfig(runtime.files, teamPaths(kitHome, team, runtime.userHome).config, format.migrations, format.version);
  const overrides = load.status === 'loaded' ? load.config.paths : {};
  return { load, paths: teamPaths(kitHome, team, runtime.userHome, overrides) };
}

/**
 * Where to look for a team pointer: the given folders in order, then the folder Claude Code started
 * the session in, so a command run from a subfolder or a temp folder still finds its team.
 */
export function teamFolders(env: Env, first: readonly (string | undefined)[]): string[] {
  return [...first, env[ENV.claudeProjectDir]].flatMap((folder) => (folder?.trim() ? [folder] : []));
}

/** A command's team: `$TEAMRIG_TEAM`, else the nearest pointer. Without one the command refuses. */
export async function openTeamKit(runtime: CliRuntime): Promise<Kit> {
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

/** What a command does with team state: a write refuses on a config a read only warns about. */
export type Access = 'read' | 'write';

export function issueText(issue: ConfigIssue): string {
  return `${issue.path === '' ? '(top level)' : issue.path}: ${issue.message}`;
}

/**
 * The team config. A config with problems still loads, each bad field on its default: reads go
 * on with a warning, writes are refused until it is fixed. A config from a newer teamrig is read
 * best-effort and never written through.
 */
export function requireConfig(kit: Kit, runtime: CliRuntime, access: Access): KitConfig {
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
