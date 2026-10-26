import { ENV } from "../../core/home.js";
import { sessionRef } from "../inputs.js";
import { sessionIdOf } from "../kit.js";
import { RefusedError } from "../runtime.js";
import { envSession, markedSessionOf } from "./hook-input.js";
/**
 * The session a command runs as: `--session` or `$TEAMRIG_SESSION`, else the session this Claude Code tab is bound
 * to; undefined when neither names one. A tab bound to a session runs only as that session, so naming another one
 * there is refused; `own` says what a session does only as itself, such as `withdraws only its own steps`.
 */
export async function tabSessionOf(args, runtime, kit, roster, own) {
    const named = args.flags.get('session') ?? envSession(runtime);
    const bound = await markedSessionOf(runtime, kit, roster, runtime.env[ENV.claudeSession]?.trim() ?? null);
    if (named === undefined) {
        return bound;
    }
    const session = sessionIdOf(roster, sessionRef('--session', named));
    if (bound !== undefined && bound !== session) {
        throw new RefusedError(`this tab is ${bound}'s: a session ${own}, not ${session}'s`);
    }
    return session;
}
