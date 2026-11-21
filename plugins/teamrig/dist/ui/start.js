import { ENV } from "../core/home.js";
/**
 * What the UI reads from its environment to call teamrig back: this CLI's entry script and the Node.js running it.
 * The UI is its own program with none of teamrig's code, and a terminal a person opened may have no `teamrig` on
 * PATH, so `teamrig ui` hands it the very CLI that started it.
 */
export const UI_ENV = { cli: 'TEAMRIG_CLI', node: 'TEAMRIG_NODE' };
/**
 * The variables a released UI gets of the caller's (T4838 N1): where programs and the home folder are, the terminal's
 * kind and colours, the locale, and the teamrig ones the CLI it calls back reads to find the kit, team and session.
 * Those are named one by one, not by their prefix, so a TEAMRIG_-named secret a person or another tool sets stays
 * behind (T4850 N1). SYSTEMROOT is there as Node.js on Windows needs it for its crypto and network calls. A UI build
 * of the person's own (`ui.path`) keeps the whole environment, as it is theirs.
 */
const RELEASED_NAMES = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'TERM',
    'COLORTERM',
    'LANG',
    'LANGUAGE',
    ENV.home,
    ENV.team,
    ENV.session,
]);
const RELEASED_PREFIXES = ['LC_'];
/** Whether a released UI gets the variable `name`; Windows names are matched in any case, as Windows reads them. */
function releasedName(name) {
    const upper = name.toUpperCase();
    return RELEASED_NAMES.has(upper) || RELEASED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
/** Only the variables of `env` a released UI gets, each under the name it has there. */
export function releasedEnv(env) {
    return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && releasedName(name)));
}
/** The UI as one program run in this terminal: `node <entry> --team <team> [--session <id>]`, in the caller's folder. */
export function uiRequest(start) {
    return {
        command: start.node,
        args: [start.entry, '--team', start.team, ...(start.session === undefined ? [] : ['--session', start.session])],
        cwd: start.cwd,
        env: { ...start.env, [UI_ENV.cli]: start.script, [UI_ENV.node]: start.node },
    };
}
