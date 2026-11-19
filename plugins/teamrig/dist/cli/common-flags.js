import { KIT_NAME } from "../core/home.js";
import { resolveTeam } from "../core/team.js";
import { openKit, rosterOf, teamFolders } from "./kit.js";
import { RefusedError } from "./runtime.js";
/**
 * `--session` and `--team` on a command that takes neither for its own use (#654): every command reads both
 * (`COMMON_FLAGS`, args.ts), since sessions name themselves out of habit; `parseArgs` keeps them in `args.common`, out
 * of the flags the command reads. Such a command ignores `--session` once it names a session of the team it runs for
 * (by id, current or former name): the `--team` it declares and was given, else this team. A command that runs for
 * this team only refuses a `--team` naming another with one line. With no team found a `--session` is not checked:
 * there is no roster to check it against, and the command reports the missing team itself when it needs one. A config
 * that does not load leaves the check to the command too, so `doctor` and `config validate` still run on a broken one.
 * `runCli` calls it only when one of the two is given to a command that does not declare it.
 */
export async function checkCommonFlags(args, runtime) {
    const session = args.common.get('session');
    const team = args.common.get('team');
    const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
    const own = found.kind === 'team' ? found.team : undefined;
    if (team !== undefined && team !== own) {
        throw new RefusedError(`${KIT_NAME} ${args.command} runs for ${thisTeamText(found)}; --team ${team} names another team`);
    }
    const target = args.flags.get('team') ?? own;
    if (session === undefined || target === undefined) {
        return;
    }
    const kit = await openKit(runtime, target);
    if (kit.load.status !== 'loaded') {
        return;
    }
    if (!(await rosterOf(runtime, kit, kit.load.config)).lookup(session).ok) {
        throw new RefusedError(`--session ${session} names no session of team ${target}: ${KIT_NAME} who lists them`);
    }
}
/** The team a command runs for, as a refusal names it: from `$TEAMRIG_TEAM` or a pointer file, broken, or none. */
function thisTeamText(found) {
    switch (found.kind) {
        case 'team':
            return `this team (${found.team}) only`;
        case 'broken':
            return `this team only, and its pointer ${found.from} ${found.problem}`;
        case 'none':
            return 'the team of this folder, and none is found here';
    }
}
