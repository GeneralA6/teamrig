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
  /**
   * The Claude Code session running a command: the inbox reminder hook follows its reads by it, and `teamrig heavy`
   * takes the session this tab is bound to from it when no session is named.
   */
  claudeSession: 'CLAUDE_CODE_SESSION_ID',
  /**
   * The token of the host lock a running step holds (`heavy`, `integrate`, `roll`), set for the processes it starts:
   * a `teamrig heavy` among them, such as a git hook's checks, runs at once under that lock instead of waiting on its parent.
   */
  hostLock: 'TEAMRIG_HOST_LOCK',
  /** The folder Claude Code started the session in; hooks and tool commands inherit it. */
  claudeProjectDir: 'CLAUDE_PROJECT_DIR',
  /** Moves Claude Code's own folder (settings, plugins, transcripts) away from `~/.claude`. */
  claudeConfigDir: 'CLAUDE_CONFIG_DIR',
  /** Moves Claude Code's temporary files, session scratchpads among them, away from the system's temporary folder. */
  claudeTempDir: 'CLAUDE_CODE_TMPDIR',
  /** The session `teamrig launch` runs Claude Code for: it starts Claude Code again after an automatic restart. */
  launched: 'TEAMRIG_LAUNCHED',
  /** `off` turns `teamrig gh sync` off on this machine: it reads nothing and writes nothing. */
  github: 'TEAMRIG_GITHUB',
  /** Claude Code's effort for every session and helper that gets it, over `--effort`, `/effort` and per-call Agent `effort`; `doctor` warns when set. */
  effortLevel: 'CLAUDE_CODE_EFFORT_LEVEL',
  /** At 1, Claude Code picks a helper's model over every per-call Agent `model`; `doctor` warns when set. */
  subagentModelForce: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  /** How Claude Code was started: `cli` for a terminal tab, the only kind the restore after a reboot reopens. */
  claudeEntrypoint: 'CLAUDE_CODE_ENTRYPOINT',
  /** `bg` for a background session, which the restore after a reboot never reopens. */
  claudeSessionKind: 'CLAUDE_CODE_SESSION_KIND',
  /** Set (`1`), Claude Code stops writing the terminal tab's title and leaves it to hooks: tab status needs it. */
  claudeTitleOff: 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
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

/** Claude Code's own folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: Env, userHome: string): string {
  const fromEnv = env[ENV.claudeConfigDir]?.trim();
  return fromEnv ? fromEnv : join(userHome, '.claude');
}

/** The folder Claude Code keeps its temporary files under (scratchpads: `<it>/claude/<project>/<session>/scratchpad`). */
export function claudeTempDir(env: Env, systemTemp: string): string {
  const fromEnv = env[ENV.claudeTempDir]?.trim();
  return fromEnv ? fromEnv : systemTemp;
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
  /** The SendMessage calls the cold-send hook held, so the same tab's next send to that session goes through. */
  readonly coldSends: string;
  /** The owner's latest daily meeting with the lead (src/meeting/state.ts); the cold-send hook holds messages to the lead while it is open. */
  readonly meeting: string;
  /** The append-only log of session renames, so every name a session has had still finds it. */
  readonly renames: string;
  readonly renamesLock: string;
  /** The Claude Code skills folder the skills lint and `--skill` checks read. */
  readonly skills: string;
  /** Each session's context-refresh state, one small file per session. */
  readonly refresh: string;
  /** The handover notes a session writes before a refresh, `<id>.md` each. */
  readonly handover: string;
  /** The verify-loop notices given today (a held start's inbox line, a verify-by reminder), so each is given once a day. */
  readonly verifyNotices: string;
  /** The model notices each session's Stop hook already showed, `<id>.json` each. */
  readonly modelNotices: string;
  /** Each session's metered use, `<id>.json` each, and `outside/` for use outside the team. */
  readonly usage: string;
  /** The skills scorecard's per-day counts and transcript positions (`teamrig skills scorecard`). */
  readonly skillsScorecard: string;
  /** The week's period: its start, its end and the latest use read in it (budget/period.ts). */
  readonly period: string;
  /** The lead's budget lifts, an append-only log. */
  readonly lifts: string;
  /** The lead's bursts and their ends, an append-only log. */
  readonly bursts: string;
  /** The team's hires and retires, an append-only log. */
  readonly hires: string;
  /** Held while a hire or a retire writes the config and the hire log, so two never interleave. */
  readonly hiresLock: string;
  /** Each hired session's due ask to retire itself (hiring/retire-ask.ts), `<id>.json` each. */
  readonly retireAsks: string;
  /** Each session's due ask to keep working while a task of it waits (wake/keep-working.ts), `<id>.json` each. */
  readonly keepWorkingAsks: string;
  /** What the budget warning already showed each session, `<id>.json` each. */
  readonly warn: string;
  /** The full output of each `teamrig test` run, `test-<session>-<n>.log` each. */
  readonly logs: string;
  /** The automatic GitHub sync's last start, finish and failing repositories (github/auto.ts). */
  readonly githubSync: string;
  /** Held while a hook claims the next automatic sync or a sync records its finish. */
  readonly githubSyncLock: string;
  /** What the wake check kept for each session (src/wake/), `<id>.json` each, and its lock, `<id>.lock`. */
  readonly wake: string;
  /** Every wake and every wake Claude Code dropped, with its cost, an append-only log. */
  readonly wakeLog: string;
  /** Each session's prompts and replies for the task pane (src/turn-log/), `<id>/<UTC hour>.jsonl` each. */
  readonly turnLog: string;
  /** Where each session last started: its Claude Code process and session, `<id>.json` each (src/sessions/record.ts). */
  readonly sessions: string;
  /** Each session `teamrig close` ended and `teamrig open` started again, an append-only log (src/sessions/log.ts). */
  readonly sessionLog: string;
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
    coldSends: join(state, 'cold-sends.jsonl'),
    meeting: join(state, 'meeting.json'),
    renames: join(state, 'renames.jsonl'),
    renamesLock: join(state, 'renames.lock'),
    skills: inHome(overrides.skills) ?? join(userHome, '.claude', 'skills'),
    refresh: join(state, 'refresh'),
    handover: inHome(overrides.handover) ?? join(home, 'handover'),
    verifyNotices: join(state, 'verify-notices.jsonl'),
    modelNotices: join(state, 'model-notices'),
    usage: join(state, 'usage'),
    skillsScorecard: join(state, 'skills-scorecard.json'),
    period: join(state, 'usage', 'period.json'),
    lifts: join(state, 'usage', 'lifts.jsonl'),
    bursts: join(state, 'usage', 'bursts.jsonl'),
    hires: join(state, 'hires.jsonl'),
    hiresLock: join(state, 'hires.lock'),
    retireAsks: join(state, 'retire-asks'),
    keepWorkingAsks: join(state, 'keep-working-asks'),
    warn: join(state, 'usage', 'warn'),
    logs: join(state, 'logs'),
    githubSync: join(state, 'github-sync.json'),
    githubSyncLock: join(state, 'github-sync.lock'),
    wake: join(state, 'wake'),
    wakeLog: join(state, 'wakes.jsonl'),
    turnLog: join(state, 'turn-log'),
    sessions: join(state, 'sessions'),
    sessionLog: join(state, 'session-log.jsonl'),
  };
}
