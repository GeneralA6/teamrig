import { isAbsolute, join } from 'node:path';
import { ID_PATTERN } from "./ids.js";
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
     * The Claude Code session running a command: the inbox reminder hook follows its reads by it, and `teamrig queue`
     * takes the session this tab is bound to from it when no session is named.
     */
    claudeSession: 'CLAUDE_CODE_SESSION_ID',
    /**
     * The token of the host lock a running step holds (`queue`, `merge`, `deploy`), set for the processes it starts:
     * a `teamrig queue` among them, such as a git hook's checks, runs at once under that lock instead of waiting on its parent.
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
    /**
     * `1` in what Claude Code starts for the agent: its Bash and PowerShell tools, the scripts they run, hook commands,
     * the status line. The plugin's mod runs commands with Claude Code's own environment, which lacks it.
     */
    claudeCode: 'CLAUDECODE',
};
/**
 * The kit home is the machine root: each team keeps its config, rules and state in its own folder
 * under `teams/`, so teams on one machine never share a file. It lives outside the plugin folders,
 * which a plugin update replaces and an uninstall deletes, so a team's register survives both.
 */
export function resolveKitHome(env, userHome) {
    const fromEnv = env[ENV.home]?.trim();
    return fromEnv ? fromEnv : join(userHome, `.${KIT_NAME}`);
}
/** Claude Code's own folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env, userHome) {
    const fromEnv = env[ENV.claudeConfigDir]?.trim();
    return fromEnv ? fromEnv : join(userHome, '.claude');
}
/** The folder Claude Code keeps its temporary files under (scratchpads: `<it>/claude/<project>/<session>/scratchpad`). */
export function claudeTempDir(env, systemTemp) {
    const fromEnv = env[ENV.claudeTempDir]?.trim();
    return fromEnv ? fromEnv : systemTemp;
}
/** The team's folder. The id is checked here too, since it becomes part of a path. */
export function teamHome(kitHome, team) {
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
export function taskFolder(kitHome, team, id) {
    return join(teamHome(kitHome, team), TASKS_FOLDER, id);
}
/** The team's paths; `claudeDir` is Claude Code's own folder (`claudeConfigDir`), whose `skills` is the default skills folder. */
export function teamPaths(kitHome, team, claudeDir, overrides = {}) {
    const home = teamHome(kitHome, team);
    const inHome = (path) => path === undefined || isAbsolute(path) ? path : join(home, path);
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
        goals: join(state, 'goals.jsonl'),
        goalsLock: join(state, 'goals.lock'),
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
        meetingBreakthrough: join(state, 'meeting-breakthrough.json'),
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
        leaderDigest: join(state, 'leader-digest'),
        effortWriteback: join(state, 'effort-writeback'),
        effortChanges: join(state, 'effort-changes.jsonl'),
        unownedNotices: join(state, 'unowned-notices.json'),
        unownedNoticesLock: join(state, 'unowned-notices.lock'),
        usage: join(state, 'usage'),
        configDirRecord: join(state, 'usage', 'claude-config-dir.json'),
        skillsScorecard: join(state, 'skills-scorecard.json'),
        period: join(state, 'usage', 'period.json'),
        meterLog: join(state, 'usage', 'meter-log.jsonl'),
        extraLog: join(state, 'usage', 'extra-log.jsonl'),
        teamWeek: join(state, 'usage', 'team.week.json'),
        rollup: join(state, 'usage', 'rollup'),
        sessionsWeek: join(state, 'usage', 'sessions.week.json'),
        tasksWeek: join(state, 'usage', 'tasks.week.json'),
        lifts: join(state, 'usage', 'lifts.jsonl'),
        cuts: join(state, 'usage', 'cuts.jsonl'),
        bursts: join(state, 'usage', 'bursts.jsonl'),
        hires: join(state, 'hires.jsonl'),
        configLock: join(state, 'hires.lock'),
        lastTaskAsks: join(state, 'last-task-asks'),
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
        tabs: join(state, 'tabs'),
        needsYouSent: join(state, 'needs-you-sent.json'),
        needsYouLock: join(state, 'needs-you.lock'),
        sessionLog: join(state, 'session-log.jsonl'),
        secretIncidents: join(state, 'secret-incidents.jsonl'),
        secretIncidentsLock: join(state, 'secret-incidents.lock'),
        execAudit: join(home, 'exec', 'audit.jsonl'),
        execAuditLock: join(home, 'exec', 'audit.lock'),
        execOut: join(home, 'exec', 'out'),
    };
}
