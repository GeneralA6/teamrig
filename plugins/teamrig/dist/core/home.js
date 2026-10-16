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
    /** The Claude Code session running a command, so the inbox reminder hook can follow its reads. */
    claudeSession: 'CLAUDE_CODE_SESSION_ID',
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
export function teamPaths(kitHome, team, userHome, overrides = {}) {
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
        inbox: inHome(overrides.inbox) ?? join(state, 'inbox'),
        inboxMarks: join(state, 'inbox-marks.jsonl'),
        inboxShown: join(state, 'inbox-shown.jsonl'),
        bindHints: join(state, 'bind-hints.jsonl'),
        coldSends: join(state, 'cold-sends.jsonl'),
        renames: join(state, 'renames.jsonl'),
        renamesLock: join(state, 'renames.lock'),
        skills: inHome(overrides.skills) ?? join(userHome, '.claude', 'skills'),
        refresh: join(state, 'refresh'),
        handover: inHome(overrides.handover) ?? join(home, 'handover'),
        verifyNotices: join(state, 'verify-notices.jsonl'),
        modelNotices: join(state, 'model-notices'),
        usage: join(state, 'usage'),
        lifts: join(state, 'usage', 'lifts.jsonl'),
        hires: join(state, 'hires.jsonl'),
        hiresLock: join(state, 'hires.lock'),
        warn: join(state, 'usage', 'warn'),
        logs: join(state, 'logs'),
        githubSync: join(state, 'github-sync.json'),
        githubSyncLock: join(state, 'github-sync.lock'),
    };
}
