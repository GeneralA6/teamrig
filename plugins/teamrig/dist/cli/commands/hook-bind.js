import { errorMessage } from "../../core/guards.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { sessionTitleOf } from "../../names/title.js";
import { bindByEnv, bindByProcess, bindByTitle, bindHint, hintReason, processBoundNote, refreshedIn } from "../../hooks/bind.js";
import { firstHint, JsonlHintLog } from "../../hooks/hint-log.js";
import { injectFor } from "../../inbox/inject.js";
import { claudeProcessOf } from "../../refresh/restart.js";
import { RefreshStore } from "../../refresh/store.js";
import { hookLogOf } from "../hook-logs.js";
import { loadTree } from "../tree.js";
import { inboxDepsOf } from "./inbox.js";
/** Reads the title once for everything a hook does with it; it never throws. */
export async function readTitle(runtime, payload) {
    try {
        return { kind: 'read', title: await sessionTitleOf(payload, runtime.files) };
    }
    catch (error) {
        return { kind: 'failed', error: errorMessage(error) };
    }
}
/** The other teams of `team`'s tree, read from every team config of the kit home. */
async function treeTeamsOf(runtime, team) {
    const { tree, teams } = await loadTree(runtime);
    return [...teams].filter(([other]) => other !== team && tree.sameTree(other, team)).map(([other, { roster }]) => ({ team: other, roster }));
}
/**
 * Binds the tab to the session its title names (hooks/bind.ts), unless `$TEAMRIG_SESSION` or a mark
 * already names it. It never throws, so the hook always answers: a failure is an outcome, and the
 * next prompt tries again.
 */
export async function bindTab(runtime, kit, own, claudeSession, title) {
    try {
        const outcome = await bindByTitle({ marks: inboxDepsOf(runtime, kit.paths).marks, treeTeams: () => treeTeamsOf(runtime, own.team) }, { own, claudeSession, envSession: (runtime.env[ENV.session]?.trim() ?? '') !== '', title: title.kind === 'read' ? title.title : undefined, now: new Date(runtime.clock.now()) });
        // A title that could not be read matters only to a tab nothing else binds.
        return { own, outcome: title.kind === 'failed' && outcome.kind === 'untitled' ? { kind: 'failed', error: title.error } : outcome };
    }
    catch (error) {
        return { own, outcome: { kind: 'failed', error: errorMessage(error) } };
    }
}
/**
 * After a /clear its title could not bind: binds the tab to the session that refreshed in this hook's Claude
 * Code process (hooks/bind.ts), and gives the SessionStart note for it. It never throws: a failure is the note.
 */
export async function bindAfterClear(runtime, kit, roster, claudeSession) {
    try {
        const pid = await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid);
        if (pid === undefined) {
            return undefined;
        }
        const now = new Date(runtime.clock.now());
        const store = new RefreshStore(runtime.files, kit.paths);
        const refreshedHere = async () => {
            const states = new Map();
            for (const id of roster.ids) {
                states.set(id, await store.state(id));
            }
            return refreshedIn(states, pid, now);
        };
        const bound = await bindByProcess({ marks: inboxDepsOf(runtime, kit.paths).marks, refreshedHere }, claudeSession, now);
        return bound === undefined ? undefined : processBoundNote(bound.id);
    }
    catch (error) {
        return `${KIT_NAME} could not bind this tab by its Claude Code process (${errorMessage(error)}).`;
    }
}
/**
 * Binds the tab `$TEAMRIG_SESSION` names to session `id` (hooks/bind.ts). It never throws, so the start always
 * loads: a failure is the SessionStart note, and the tab's first `inbox read` writes the mark.
 */
export async function bindNamedTab(runtime, kit, id, claudeSession) {
    try {
        await bindByEnv(inboxDepsOf(runtime, kit.paths).marks, id, claudeSession, new Date(runtime.clock.now()));
        return undefined;
    }
    catch (error) {
        return `${KIT_NAME} could not bind this tab to the \`${id}\` session (${errorMessage(error)}); its first \`inbox read\` does.`;
    }
}
/** The prompt hook's line for a tab it could not bind, once per Claude Code session and reason; undefined otherwise. */
export async function bindHintOnce(runtime, kit, binding, claudeSession) {
    const hint = bindHint(binding.outcome, binding.own, KIT_NAME);
    const reason = hintReason(binding.outcome);
    if (hint === undefined || reason === undefined) {
        return undefined;
    }
    const log = new JsonlHintLog(hookLogOf(runtime, kit.paths, 'bind-hints'));
    return (await firstHint(log, claudeSession, reason, new Date(runtime.clock.now()))) ? hint : undefined;
}
/** The session's new inbox lines for this prompt (inbox/inject.ts) on the team's clock, recorded as shown; undefined when none wait. */
export function inboxLinesFor(runtime, kit, session, claudeSession, zone) {
    return injectFor(inboxDepsOf(runtime, kit.paths), { area: session, claudeSession, now: new Date(runtime.clock.now()), zone, command: KIT_NAME });
}
