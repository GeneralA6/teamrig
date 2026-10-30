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
   * The token of the host lock a running step holds (`heavy`, `merge`, `deploy`), set for the processes it starts:
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
  /** A tree's root team's: taken by every task created in the tree, so one number is issued once (T1139). */
  readonly idsLock: string;
  readonly inbox: string;
  readonly inboxMarks: string;
  /** What the prompt hook showed each Claude Code session of its inbox, so each line is shown once. */
  readonly inboxShown: string;
  /** Taken by every write of `inboxShown`, which archives its records older than a week (core/aged-log.ts). */
  readonly inboxShownLock: string;
  /** The hints the hooks gave each Claude Code session (bind hints, missing requirements), so each is given once. */
  readonly bindHints: string;
  /** Taken by every write of `bindHints`, which archives its records older than a week (core/aged-log.ts). */
  readonly bindHintsLock: string;
  /** The state archive: the register's segments and the aged logs' old records, never deleted. */
  readonly archive: string;
  /** The SendMessage calls the cold-send hook held, so the same tab's next send to that session goes through. */
  readonly coldSends: string;
  /** The owner's latest daily meeting with the lead (src/meeting/state.ts); the cold-send hook holds messages to the lead while it is open. */
  readonly meeting: string;
  /** The owner's scheduled meetings with one session each (src/meeting/schedule.ts), rewritten under meetingsLock. */
  readonly meetings: string;
  readonly meetingsLock: string;
  /** The last batch of the owner's decisions the lead asked (src/decisions/store.ts). */
  readonly decisionsAsked: string;
  /** The candidate lines `rules clear` recorded as not conflicting with a core rule (src/rules/verdicts.ts). */
  readonly ruleVerdicts: string;
  /** The append-only log of session renames, so every name a session has had still finds it. */
  readonly renames: string;
  readonly renamesLock: string;
  /** The Claude Code skills folder the skills lint and `--skill` checks read. */
  readonly skills: string;
  /** Each session's context-refresh state, one small file per session. */
  readonly refresh: string;
  /** The handover notes a session writes before a refresh, `<id>.md` each. */
  readonly handover: string;
  /** Each task's files (design, build notes, plan, evidence), `T<id>/` each: see {@link taskFolder} (T1457). */
  readonly tasks: string;
  /** Each session's notes that belong to no task (research, boards, drafts), `<session>/` each (T1457). */
  readonly notes: string;
  /** The verify-loop notices given today (a held start's inbox line, a verify-by reminder), so each is given once a day. */
  readonly verifyNotices: string;
  /** The model notices each session's Stop hook already showed, `<id>.json` each. */
  readonly modelNotices: string;
  /** The warnings no session owns the lead was told of, with when a start last saw each, so each is told once while it stands (T951). */
  readonly unownedNotices: string;
  /** Held while a start tells the lead of those warnings, so two starts never tell one twice. */
  readonly unownedNoticesLock: string;
  /** Each session's metered use, `<id>.json` each, and `outside/` for use outside the team. */
  readonly usage: string;
  /** The skills scorecard's per-day counts and transcript positions (`teamrig skills scorecard`). */
  readonly skillsScorecard: string;
  /** The week's period: its start, its end and the latest use read in it (budget/period.ts). */
  readonly period: string;
  /** Each percent of the week the status line passed and the W metered for it, an append-only log (budget/calibration.ts). */
  readonly meterLog: string;
  /** The extra-usage pool's adds and spent readings, an append-only log (budget/extra.ts). */
  readonly extraLog: string;
  /** The leaders' budget lifts, an append-only log. */
  readonly lifts: string;
  /** The lead's bursts and their ends, an append-only log. */
  readonly bursts: string;
  /** The team's hires and retires, an append-only log. */
  readonly hires: string;
  /** Held while a hire or a retire writes the config and the hire log, so two never interleave. */
  readonly hiresLock: string;
  /** Each hired session's due ask to write its handover (hiring/retire-ask.ts), `<id>.json` each. */
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
  /** The hookless-tab check's last run and the tabs it named (restore/hookless.ts). */
  readonly hookless: string;
  /** Held while a hook runs the hookless-tab check. */
  readonly hooklessLock: string;
  /** The idle pass's last run and each session's step then (src/cli/idle-pass-log.ts). */
  readonly idlePass: string;
  /** Held while a wake check runs the idle pass. */
  readonly idlePassLock: string;
  /** Each idle pass that changed a session's step, and each new failure of one, an append-only log. */
  readonly idlePassLog: string;
  /**
   * What the wake check kept for each session (src/wake/), `<id>.json` each, its lock, `<id>.lock`, and its last
   * wake's prompt until the turn log takes it, `<id>.prompt.json` (src/wake/prompts.ts).
   */
  readonly wake: string;
  /** The lines waiting to wake each session at its next wake check (src/wake/asks.ts), `<id>/<at>-<n>.json` each. */
  readonly wakeAsks: string;
  /** Every wake and every wake Claude Code dropped, with its cost, an append-only log. */
  readonly wakeLog: string;
  /** The settings `teamrig launch` passes each session's Claude Code (src/cli/skill-listing.ts), `<id>.settings.json` each. */
  readonly launchSettings: string;
  /** Each permission prompt the prompt refusal answered and how (hooks/prompt-refuse.ts); records over a week old move to the archive. */
  readonly promptAnswers: string;
  /** Taken by every write of `promptAnswers`, which archives its records older than a week (core/aged-log.ts). */
  readonly promptAnswersLock: string;
  /** Each session's prompts and replies for the task pane (src/turn-log/), `<id>/<UTC hour>.jsonl` each. */
  readonly turnLog: string;
  /** Where each session last started: its Claude Code process and session, `<id>.json` each (src/sessions/record.ts). */
  readonly sessions: string;
  /** Each session `teamrig close` ended and `teamrig open` started again, an append-only log (src/sessions/log.ts). */
  readonly sessionLog: string;
  /** Each kind of secret a tool's result held and the task that has it rotated, an append-only audit log nothing trims (src/secret-guard/incidents.ts). */
  readonly secretIncidents: string;
  /** Held while the secret redactor reads the incident log, files a rotation task and appends the incident. */
  readonly secretIncidentsLock: string;
  /** Every privileged command's request, review and run, a hash-chained append-only log (src/exec/audit.ts); kept in the team folder, out of reach of a state override. */
  readonly execAudit: string;
  /** Held while a command appends to the exec audit log. */
  readonly execAuditLock: string;
  /** Each privileged command's redacted output, `R<n>-dry.log` for its dry run and `R<n>-run.log` for its run (src/exec/runner.ts). */
  readonly execOut: string;
}

/** The team's folder. The id is checked here too, since it becomes part of a path. */
export function teamHome(kitHome: string, team: string): string {
  if (!ID_PATTERN.test(team)) {
    throw new Error(`"${team}" is not a team id`);
  }
  return join(kitHome, 'teams', team);
}

const TASKS_FOLDER = 'tasks';

/**
 * The folder of one task's files, in the team whose register holds the task (T1457): its files move with it, and a
 * task's design is found by its id, never by a search.
 */
export function taskFolder(kitHome: string, team: string, id: string): string {
  return join(teamHome(kitHome, team), TASKS_FOLDER, id);
}

/** The team's paths; `claudeDir` is Claude Code's own folder (`claudeConfigDir`), whose `skills` is the default skills folder. */
export function teamPaths(kitHome: string, team: string, claudeDir: string, overrides: PathOverrides = {}): TeamPaths {
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
    idsLock: join(state, 'ids.lock'),
    inbox: inHome(overrides.inbox) ?? join(state, 'inbox'),
    inboxMarks: join(state, 'inbox-marks.jsonl'),
    inboxShown: join(state, 'inbox-shown.jsonl'),
    inboxShownLock: join(state, 'inbox-shown.lock'),
    bindHints: join(state, 'bind-hints.jsonl'),
    bindHintsLock: join(state, 'bind-hints.lock'),
    archive: join(state, 'archive'),
    coldSends: join(state, 'cold-sends.jsonl'),
    meeting: join(state, 'meeting.json'),
    meetings: join(state, 'meetings.jsonl'),
    meetingsLock: join(state, 'meetings.lock'),
    decisionsAsked: join(state, 'decisions-asked.json'),
    ruleVerdicts: join(state, 'rule-verdicts.json'),
    renames: join(state, 'renames.jsonl'),
    renamesLock: join(state, 'renames.lock'),
    skills: inHome(overrides.skills) ?? join(claudeDir, 'skills'),
    refresh: join(state, 'refresh'),
    handover: inHome(overrides.handover) ?? join(home, 'handover'),
    tasks: join(home, TASKS_FOLDER),
    notes: join(home, 'notes'),
    verifyNotices: join(state, 'verify-notices.jsonl'),
    modelNotices: join(state, 'model-notices'),
    unownedNotices: join(state, 'unowned-notices.json'),
    unownedNoticesLock: join(state, 'unowned-notices.lock'),
    usage: join(state, 'usage'),
    skillsScorecard: join(state, 'skills-scorecard.json'),
    period: join(state, 'usage', 'period.json'),
    meterLog: join(state, 'usage', 'meter-log.jsonl'),
    extraLog: join(state, 'usage', 'extra-log.jsonl'),
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
    hookless: join(state, 'hookless.json'),
    hooklessLock: join(state, 'hookless.lock'),
    idlePass: join(state, 'idle-pass.json'),
    idlePassLock: join(state, 'idle-pass.lock'),
    idlePassLog: join(state, 'idle-pass.jsonl'),
    wake: join(state, 'wake'),
    wakeAsks: join(state, 'wake-asks'),
    wakeLog: join(state, 'wakes.jsonl'),
    launchSettings: join(state, 'launch'),
    promptAnswers: join(state, 'prompt-answers.jsonl'),
    promptAnswersLock: join(state, 'prompt-answers.lock'),
    turnLog: join(state, 'turn-log'),
    sessions: join(state, 'sessions'),
    sessionLog: join(state, 'session-log.jsonl'),
    secretIncidents: join(state, 'secret-incidents.jsonl'),
    secretIncidentsLock: join(state, 'secret-incidents.lock'),
    execAudit: join(home, 'exec', 'audit.jsonl'),
    execAuditLock: join(home, 'exec', 'audit.lock'),
    execOut: join(home, 'exec', 'out'),
  };
}
