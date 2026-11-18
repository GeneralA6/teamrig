import { launchOf } from "../../config/launch.js";
import { errorMessage } from "../../core/guards.js";
import { SessionLog } from "../../sessions/log.js";
import { readIdlePassState } from "../idle-pass-check.js";
import { isTreePassDue } from "../idle-pass-log.js";
import { RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { runIdlePass } from "./hook-idle-pass.js";
import { projectOf } from "./setup.js";
/** The folder the last close of `id` logged, which its reopen resumes in (src/sessions/log.ts). */
function lastClosedFolderOf(records, id) {
    let folder;
    for (const record of records) {
        if (record.kind === 'close' && record.session === id && record.folder !== undefined) {
            folder = record.folder;
        }
    }
    return folder;
}
/**
 * The folder of a session of a team run from another team's tab: its `launch.<id>.project`, the team's
 * `team.project`, else the folder its last close logged. Never the calling tab's folder, which is another team's;
 * with none of them the session is refused, so the pass holds only it.
 */
function treeFoldersOf(runtime, config, records) {
    return async (id) => {
        const named = launchOf(config, id).project ?? config.team?.project ?? lastClosedFolderOf(records, id);
        if (named === undefined) {
            throw new RefusedError(`no folder is known for session ${id}: set launch.${id}.project or team.project`);
        }
        return projectOf(runtime, named);
    };
}
/**
 * Runs the idle pass of each other team of `own`'s tree that no tab of its own ran for `TREE_PASS_AFTER_MS` (T3387):
 * a team runs its pass only from its own tabs' wake checks, so once the pass closed its last session nothing reopened
 * it. Each team's pass keeps its own mode, lock and minute; a team's failure is warned on stderr and costs neither
 * this tab's wake answer nor the other teams' passes.
 */
export async function runTreeIdlePasses(runtime, own) {
    const { tree, teams } = await loadTree(runtime);
    const now = runtime.clock.now();
    for (const [team, { kit, config, roster }] of teams) {
        if (team === own || !tree.sameTree(team, own)) {
            continue;
        }
        try {
            if (isTreePassDue(await readIdlePassState(runtime.files, kit.paths), now)) {
                const { records } = await new SessionLog(runtime.files, kit.paths.sessionLog).read();
                await runIdlePass(runtime, kit, config, roster, treeFoldersOf(runtime, config, records));
            }
        }
        catch (error) {
            runtime.out.stderr(`WARN the idle pass of team ${team}, run from team ${own}, failed: ${errorMessage(error)}; the next pass tries again`);
        }
    }
}
