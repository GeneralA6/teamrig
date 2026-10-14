import { isAbsolute, join } from 'node:path';
import { ID_PATTERN } from './ids.ts';

export const KIT_NAME = 'teamrig';

/** Environment variables the kit reads; everything else comes from the config file. */
export const ENV = {
  /** Overrides the kit home folder. */
  home: 'TEAMRIG_HOME',
  /** The team a command or hook runs for; wins over a `.teamrig.json` pointer. */
  team: 'TEAMRIG_TEAM',
  /** The calling session's name when `--session` is not given. */
  session: 'TEAMRIG_SESSION',
  /** The plugin's `home` user option, as Claude Code passes it to hooks. */
  pluginHomeOption: 'CLAUDE_PLUGIN_OPTION_HOME',
  /** The Claude Code session running a command, so the inbox reminder hook can follow its reads. */
  claudeSession: 'CLAUDE_CODE_SESSION_ID',
  /** The folder Claude Code started the session in; hooks and tool commands inherit it. */
  claudeProjectDir: 'CLAUDE_PROJECT_DIR',
} as const;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The kit home is the machine root: each team keeps its config, rules and state in its own folder
 * under `teams/`, so teams on one machine never share a file. It lives outside the plugin folders,
 * which a plugin update replaces and an uninstall deletes, so a team's register survives both.
 */
export function resolveKitHome(env: Env, userHome: string): string {
  const fromEnv = env[ENV.home]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromPlugin = env[ENV.pluginHomeOption]?.trim();
  return fromPlugin ? fromPlugin : join(userHome, `.${KIT_NAME}`);
}

/**
 * Folders a team may move with `paths` in the config. A relative path is resolved against the team
 * home; unset, state and inbox stay under the team home and skills is the Claude Code skills folder.
 */
export interface PathOverrides {
  readonly state?: string;
  readonly inbox?: string;
  readonly skills?: string;
}

export interface TeamPaths {
  readonly kitHome: string;
  readonly team: string;
  /** `<kit home>/teams/<team>`: the team's config, rules and state. */
  readonly home: string;
  readonly config: string;
  readonly teamRules: string;
  readonly backups: string;
  readonly state: string;
  readonly events: string;
  readonly eventsLock: string;
  readonly inbox: string;
  readonly inboxMarks: string;
  /** The Claude Code skills folder the skills lint and `--skill` checks read. */
  readonly skills: string;
}

/** The team's folder. The id is checked here too, since it becomes part of a path. */
export function teamHome(kitHome: string, team: string): string {
  if (!ID_PATTERN.test(team)) {
    throw new Error(`"${team}" is not a team id`);
  }
  return join(kitHome, 'teams', team);
}

export function teamPaths(kitHome: string, team: string, userHome: string, overrides: PathOverrides = {}): TeamPaths {
  const home = teamHome(kitHome, team);
  const inHome = (path: string | undefined): string | undefined =>
    path === undefined || isAbsolute(path) ? path : join(home, path);
  const state = inHome(overrides.state) ?? join(home, 'state');
  return {
    kitHome,
    team,
    home,
    config: join(home, 'config.json'),
    teamRules: join(home, 'rules.md'),
    backups: join(home, 'backups'),
    state,
    events: join(state, 'events.jsonl'),
    eventsLock: join(state, 'events.lock'),
    inbox: inHome(overrides.inbox) ?? join(state, 'inbox'),
    inboxMarks: join(state, 'inbox-marks.jsonl'),
    skills: inHome(overrides.skills) ?? join(userHome, '.claude', 'skills'),
  };
}
