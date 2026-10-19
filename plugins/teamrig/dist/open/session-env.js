import { ENV } from "../core/home.js";
import { isPluginCacheBin } from "../core/installed-plugins.js";
import { envKey, pathList } from "../core/path-search.js";
/**
 * Variables a running Claude Code session sets for its own tools. A terminal started from inside one
 * (Konsole and x-terminal-emulator inherit this process's environment) would pass them on, and the new
 * session would look nested inside the old one and could reach its messaging socket.
 */
export const CLAUDE_SESSION_VARIABLES = [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_PID',
    'CLAUDE_PROJECT_DIR',
];
/** Variables that make Claude Code a teamrig session: its id, its team, and that `launch` runs it. */
const TEAMRIG_SESSION_VARIABLES = [ENV.session, ENV.team, ENV.launched];
function withoutVariables(env, names) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name.toUpperCase())));
}
/**
 * PATH without Claude Code's plugin `bin` folders (isPluginCacheBin). The opener's PATH holds those of the plugin
 * versions its own session started with. Claude Code adds a session's own at the end of its Bash tool's PATH, and adds
 * them again after a plugin update and /reload-plugins, so an inherited one would sit ahead of them and keep every Bash
 * call in the new session on the opener's version for the life of its process (T494). Every other entry stays as it was.
 */
function withoutPluginBins(env, platform) {
    const key = envKey(env, 'PATH', platform);
    const value = key === undefined ? undefined : env[key];
    if (key === undefined || value === undefined) {
        return env;
    }
    const delimiter = platform === 'win32' ? ';' : ':';
    // pathList reads one entry the way a PATH search does (trimmed, unquoted); the kept entries keep their own spelling.
    const kept = value.split(delimiter).filter((entry) => !pathList(entry, delimiter).some(isPluginCacheBin));
    return { ...env, [key]: kept.join(delimiter) };
}
/**
 * The environment Claude Code starts in: the session and team set, so every hook and `teamrig`
 * command in it knows who it is, and the opener's own Claude Code session variables and plugin
 * `bin` folders left out.
 */
export function sessionEnv(env, identity, platform) {
    return {
        ...withoutVariables(withoutPluginBins(env, platform), CLAUDE_SESSION_VARIABLES),
        [ENV.session]: identity.id,
        [ENV.team]: identity.team,
        ...(identity.home === undefined ? {} : { [ENV.home]: identity.home }),
    };
}
/**
 * The environment a session outside any team resumes in: neither the opener's Claude Code session variables nor its
 * teamrig session, so the resumed session is not taken for the opener, nor its plugin `bin` folders; the kit home set
 * when it is not the default.
 */
export function plainSessionEnv(env, home, platform) {
    return {
        ...withoutVariables(withoutPluginBins(env, platform), [...CLAUDE_SESSION_VARIABLES, ...TEAMRIG_SESSION_VARIABLES]),
        ...(home === undefined ? {} : { [ENV.home]: home }),
    };
}
