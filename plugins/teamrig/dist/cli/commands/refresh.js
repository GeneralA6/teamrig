import { errorMessage } from "../../core/guards.js";
import { boundaryOf, decideReady } from "../../refresh/decide.js";
import { RefreshStore } from "../../refresh/store.js";
import { noPositionals, onePositional } from "../args.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
/**
 * Context refresh from the command line: the lead asks for a session's refresh (`refresh <session>`),
 * and a session tells the kit its handover is written (`refresh --ready`). The Stop and SessionStart
 * hooks do the rest; `set done` marks the task boundary the Stop hook judges (`markBoundary`).
 */
function requireRefresh(config) {
    if (!config.refresh.enabled) {
        throw new RefusedError('context refresh is off for this team (refresh.enabled in the team config)');
    }
}
/**
 * After the caller's `set <id> --status done`: a boundary for the Stop hook to judge at the end of
 * this turn, counting the task. The task is already done, so a failure here only warns and the exit stays 0.
 */
export async function markBoundary(runtime, config, paths, session, task) {
    if (!config.refresh.enabled) {
        return;
    }
    try {
        const store = new RefreshStore(runtime.files, paths);
        await store.setState(session, boundaryOf(await store.state(session), task, new Date(runtime.clock.now()).toISOString()));
    }
    catch (error) {
        runtime.out.stderr(`WARN ${task} is done, but its refresh check was not recorded: ${errorMessage(error)}`);
    }
}
/** `refresh <session>` (the lead) or `refresh --ready` (the session itself). */
export async function refresh(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const ready = args.switches.has('ready');
    if (ready) {
        noPositionals(args);
    }
    const target = ready ? undefined : onePositional(args, 'session');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    requireRefresh(config);
    const roster = await rosterOf(runtime, kit, config);
    const by = sessionIdOf(roster, caller);
    const store = new RefreshStore(runtime.files, kit.paths);
    const now = new Date(runtime.clock.now()).toISOString();
    if (target === undefined) {
        const decision = decideReady(await store.state(by), await store.handover(by), store.handoverPath(by), now);
        switch (decision.kind) {
            case 'refused':
                throw new RefusedError(decision.reason);
            case 'ready':
                await store.setState(by, decision.state);
                break;
            case 'already':
                break;
        }
        runtime.out.stdout(`Ready. Ask the user to type /clear; your next start reads ${store.handoverPath(by)}.`);
        return EXIT.ok;
    }
    const lead = roster.holderOf('lead');
    if (by !== lead) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} asks for a refresh`);
    }
    const id = sessionIdOf(roster, target);
    await store.setRequest(id, { by, at: now });
    runtime.out.stdout(`REQUESTED a refresh of ${roster.nameOf(id) ?? id}: after its next \`set done\` it writes its handover to ` +
        `${store.handoverPath(id)}; then type /clear in its tab`);
    return EXIT.ok;
}
