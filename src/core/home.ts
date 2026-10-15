import { isAbsolute, join } from 'node:path';
import { ID_PATTERN } from './ids.ts';

export const KIT_NAME = 'teamrig';

/** Environment variables the kit reads; everything else comes from the config file. */
export const ENV = {
  /**
   * Overrides the kit home folder. It is the only override: a plugin user option would reach the hooks
   * but not the `teamrig` commands Claude runs in its Bash tool, so the two would use different homes.
   */
  home: 'TEAMRIG_HOME',
  /** The team a command or hook runs for; wins over a `.teamrig.json` pointer. */
  team: 'TEAMRIG_TEAM',
  /** The calling session's name when `--session` is not given. */
  session: 'TEAMRIG_SESSION',
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
  return fromEnv ? fromEnv : join(userHome, `.${KIT_NAME}`);
}

/**
 * Folders a team may move in the config: `paths`, and `refresh.handoverDir` for the handover. A
 * relative path is resolved against the team home; unset, state, inbox and handover stay under the
 * team home and skills is the Claude Code skills folder.
 */
export interface PathOverrides {
  readonly state?: string;
  readonly inbox?: string;
  readonly skills?: string;
  readonly handover?: string;
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
  /** What the prompt hook showed each Claude Code session of its inbox, so each line is shown once. */
  readonly inboxShown: string;
  /** The hints the hooks gave each Claude Code session (bind hints, missing requirements), so each is given once. */
  readonly bindHints: string;
  /** The append-only log of session renames, so every name a session has had still finds it. */
  readonly renames: string;
  readonly renamesLock: string;
  /** The Claude Code skills folder the skills lint and `--skill` checks read. */
  readonly skills: string;
  /** Each session's context-refresh state, one small file per session. */
  readonly refresh: string;
  /** The handover notes a session writes before a refresh, `<id>.md` each. */
  readonly handover: string;
  /** The model notices each session's Stop hook already showed, `<id>.json` each. */
  readonly modelNotices: string;
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
    inboxShown: join(state, 'inbox-shown.jsonl'),
    bindHints: join(state, 'bind-hints.jsonl'),
    renames: join(state, 'renames.jsonl'),
    renamesLock: join(state, 'renames.lock'),
    skills: inHome(overrides.skills) ?? join(userHome, '.claude', 'skills'),
    refresh: join(state, 'refresh'),
    handover: inHome(overrides.handover) ?? join(home, 'handover'),
    modelNotices: join(state, 'model-notices'),
  };
}
