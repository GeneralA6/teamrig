import { basename, dirname } from 'node:path';
import { ConfigLock } from '../config/config-lock.ts';
import { formatConfig, loadConfig, type ConfigLoad } from '../config/load.ts';
import { SHIPPED_CONFIG_FORMAT } from '../config/migrate.ts';
import type { ConfigIssue } from '../config/reader.ts';
import { Roster } from '../config/roster.ts';
import { parseConfigText } from '../config/text.ts';
import type { KitConfig } from '../config/types.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { claudeConfigDir, ENV, KIT_NAME, resolveKitHome, teamPaths, type Env, type PathOverrides, type TeamPaths } from '../core/home.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { resolveTeam, TEAM_POINTER } from '../core/team.ts';
import { TimeZone } from '../core/zone.ts';
import { JsonlRenameLog } from '../names/log.ts';
import type { RenameDeps } from '../names/record.ts';
import type { RulesClock } from '../rules/pack.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';
import { fileLockOf } from './file-locks.ts';

export interface Kit {
  readonly paths: TeamPaths;
  readonly load: ConfigLoad;
}

/** The lock every change to the team's config is read and written under (config-lock.ts). */
export function configLockOf(runtime: CliRuntime, kit: Kit, config: KitConfig): ConfigLock {
  const place = { configPath: kit.load.path, backupsDir: kit.paths.backups };
  return new ConfigLock(fileLockOf(runtime, kit.paths.configLock, config.lock), runtime.files, runtime.clock, place);
}

/** The rename log, its lock and the roster it gives, for recording a rename. */
export function renameDepsOf(runtime: CliRuntime, kit: Kit, config: KitConfig): RenameDeps {
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
export async function rosterOf(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<Roster> {
  const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
  return new Roster(config, kit.paths.team, renames);
}

/** The id of the session a command line names by id, current name or former name; anything else is refused. */
export function sessionIdOf(roster: Roster, text: string): string {
  const found = roster.lookup(text);
  if (!found.ok) {
    throw new RefusedError(found.error);
  }
  return found.id;
}

/** The caller's id when it leads the team; anyone else is refused, naming the lead and `what` only the lead does. */
export function leadOnly(roster: Roster, caller: string, what: string): string {
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
export function pastOrPresentIdOf(roster: Roster, text: string): string {
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
function overridesOf(config: KitConfig): PathOverrides {
  const { handoverDir } = config.refresh;
  return { ...config.paths, ...(handoverDir === undefined ? {} : { handover: handoverDir }) };
}

/**
 * The team's folder under the kit home, its config and the paths the config moves. A team under another takes the
 * budget keys of the account's week it leaves unset from the team above (`AccountBudget`).
 */
export async function openKit(runtime: CliRuntime, team: string): Promise<Kit> {
  const kitHome = resolveKitHome(runtime.env, runtime.userHome);
  const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
  const load = await teamConfigOf(runtime, team, []);
  return { load, paths: teamPaths(kitHome, team, claudeDir, load.status === 'loaded' ? overridesOf(load.config) : {}) };
}

/** The team's config as its file reads now, read the way `openTeamKit` read it: for a change made under the config lock. */
export function reloadTeamConfig(runtime: CliRuntime, kit: Kit): Promise<ConfigLoad> {
  return teamConfigOf(runtime, kit.paths.team, []);
}

/**
 * A team's config over the team above's (`openKit`); `below` holds the teams it is read for, so parent links that go
 * round in a loop end at the first team met again, which `doctor` names (tree-loop).
 */
async function teamConfigOf(runtime: CliRuntime, team: string, below: readonly string[]): Promise<ConfigLoad> {
  const format = runtime.configFormat ?? SHIPPED_CONFIG_FORMAT;
  const path = teamPaths(resolveKitHome(runtime.env, runtime.userHome), team, claudeConfigDir(runtime.env, runtime.userHome)).config;
  const chain = [...below, team];
  return loadConfig(runtime.files, path, format.migrations, format.version, async (own) => {
    const parent = own.team?.parent;
    if (parent === undefined || chain.includes(parent)) {
      return undefined;
    }
    const above = await teamConfigOf(runtime, parent, chain);
    return above.status === 'loaded' ? above.config.budget : undefined;
  });
}

/**
 * Where to look for a team pointer: the given folders in order, then the folder Claude Code started
 * the session in, so a command run from a subfolder or a temp folder still finds its team.
 */
export function teamFolders(env: Env, first: readonly (string | undefined)[]): string[] {
  return [...first, env[ENV.claudeProjectDir]].flatMap((folder) => (folder?.trim() ? [folder] : []));
}

/** A command's team, and where it was found: `$TEAMRIG_TEAM`, or the path of the pointer file. */
export interface FoundTeam {
  readonly team: string;
  readonly from: string;
}

/** A command's team: `$TEAMRIG_TEAM`, else the nearest pointer. Without one the command refuses. */
export async function findTeam(runtime: CliRuntime): Promise<FoundTeam> {
  const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
  switch (found.kind) {
    case 'none':
      throw new RefusedError(
        `no team here: create one with ${KIT_NAME} team create <team> --sessions <id,id>, set $${ENV.team}, or put ${TEAM_POINTER} {"team": "<id>"} in the project folder`,
      );
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
export async function projectFolder(runtime: CliRuntime, config: KitConfig): Promise<string> {
  const { from } = await findTeam(runtime);
  return teamProjectOf(config, from) ?? teamFolders(runtime.env, [])[0] ?? runtime.cwd;
}

/**
 * The team's project folder by its config and the pointer it was found by (`FoundTeam.from`): `team.project`,
 * else the pointer's folder; none for a team named by `$TEAMRIG_TEAM` alone.
 */
export function teamProjectOf(config: KitConfig, from: string): string | undefined {
  return config.team?.project ?? (basename(from) === TEAM_POINTER ? dirname(from) : undefined);
}

/** The kit of a command's team (see `findTeam`). */
export async function openTeamKit(runtime: CliRuntime): Promise<Kit> {
  return openKit(runtime, (await findTeam(runtime)).team);
}

/** What a command does with team state: a write refuses on a config a read only warns about. */
export type Access = 'read' | 'write';

export function issueText(issue: ConfigIssue): string {
  return `${issue.path === '' ? '(top level)' : issue.path}: ${issue.message}`;
}

/**
 * The config a command is about to write, read back as every later command will read it; refused, so nothing
 * is written, when it would not load or would load with a problem.
 */
export function checkedNextConfig(json: JsonRecord): KitConfig {
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
export function teamZone(config: Pick<KitConfig, 'timeZone'>, runtime: Pick<CliRuntime, 'timeZone'>): TimeZone {
  return TimeZone.resolve(config.timeZone, runtime.timeZone);
}

/** The clock the start rules are read on: this moment, and the machine's zone a team without `timeZone` reads them in. */
export function rulesClockOf(runtime: Pick<CliRuntime, 'clock' | 'timeZone'>): RulesClock {
  return { now: new Date(runtime.clock.now()), machineZone: runtime.timeZone };
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
export async function configFileJson(runtime: CliRuntime, path: string): Promise<JsonRecord> {
  const text = await runtime.files.read(path);
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!isRecord(raw)) {
    throw new RefusedError(`${path} changed while it was read; run the command again`);
  }
  return raw;
}
