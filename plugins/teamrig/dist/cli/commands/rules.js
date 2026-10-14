import { Roster } from "../../config/roster.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { sessionStartContext } from "../../hooks/session-start.js";
import { JsonlRenameLog } from "../../names/log.js";
import { noPositionals } from "../args.js";
import { sessionRef } from "../inputs.js";
import { findTeam, openKit, requireConfig, sessionIdOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
/**
 * `rules [--session <id|name>]`: the team's rules and who the session is, the same text the
 * SessionStart hook gives. A tab that set the team up started with no team, so it loads them with
 * this instead of a restart.
 */
export async function rules(args, runtime) {
    noPositionals(args);
    const { team } = await findTeam(runtime);
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    const flag = args.flags.get('session');
    if (flag !== undefined) {
        sessionIdOf(new Roster(config, kit.paths.team, renames), sessionRef('--session', flag));
    }
    const fromEnv = runtime.env[ENV.session]?.trim();
    const inEnv = flag === undefined && fromEnv !== undefined && fromEnv !== '';
    const text = await runtime.files.read(kit.paths.teamRules);
    const { tree } = await loadTree(runtime);
    const context = sessionStartContext({
        team,
        load: kit.load,
        teamRules: text === undefined ? undefined : { path: kit.paths.teamRules, text },
        renames,
        titleNote: undefined,
        refreshNote: undefined,
        session: flag ?? (inEnv ? fromEnv : undefined),
        sessionInEnv: inEnv,
        tree: tree.placeOf(team),
        command: KIT_NAME,
    });
    runtime.out.stdout(context);
    return EXIT.ok;
}
