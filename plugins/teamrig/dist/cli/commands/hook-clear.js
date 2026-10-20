import { resolveKitHome } from "../../core/home.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { CLAIM_HELD, CLAIM_TAKEN, HOLD_SWITCH, isClaudeSessionId, WHY_FLAG } from "../../mod/clear-hand.js";
import { ClearAsks, clearAskDir } from "../../refresh/clear-asks.js";
import { RefreshStore } from "../../refresh/store.js";
import { noPositionals } from "../args.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson } from "./hook-input.js";
function asksOf(runtime) {
    return new ClearAsks(runtime.files, clearAskDir(resolveKitHome(runtime.env, runtime.userHome)));
}
/** `hook clear-dir`: prints the folder of the restart's asks, which the plugin's mod watches for its tab's. */
export async function clearDir(args, runtime) {
    noPositionals(args);
    runtime.out.stdout(clearAskDir(resolveKitHome(runtime.env, runtime.userHome)));
    return EXIT.ok;
}
/** Why the ask was answered before this claim or hold: the restart took it back, or the tab answered it already. */
async function answeredProblem(asks, claudeSession) {
    const outcome = await asks.outcome(claudeSession);
    return outcome === CLAIM_TAKEN || outcome === CLAIM_HELD ? `the ask was already ${outcome}` : 'the restart took its ask back';
}
/** Why the tab may not claim (or hold) its ask; undefined once it has. */
async function claimProblem(runtime, asks, claudeSession, answer) {
    const ask = await asks.ask(claudeSession);
    if (ask === undefined) {
        return 'no ask for this session';
    }
    const kit = await openKit(runtime, ask.team);
    const store = new RefreshStore(runtime.files, kit.paths);
    const request = await store.restart(ask.id);
    if (request?.phase !== 'pending' || request.at !== ask.at || request.claudeSession !== claudeSession) {
        return 'the restart is no longer pending';
    }
    if (!(await (answer.kind === 'hold' ? asks.hold(claudeSession, answer.why) : asks.claim(claudeSession)))) {
        return answeredProblem(asks, claudeSession);
    }
    // Held: the request stays pending, so the restart waits for quiet and asks again.
    if (answer.kind === 'claim') {
        // Claimed: the request goes now, so a prompt typed before the /clear runs is not told it was cancelled.
        await store.clearRestart(ask.id);
    }
    return undefined;
}
/**
 * `hook clear-claim`, run by the plugin's mod with `{"session_id": ...}` on stdin once it sees its tab's
 * ask while no turn runs: claims the ask while the restart it is for is still pending, and prints `taken`
 * (the mod then runs /clear) or `declined: <why>`. With `--hold` (a helper the /clear or an end could cut
 * off, a draft, the person or the band's count holds it) it holds the ask instead and prints `held`: the
 * request stays pending and the restart, seeing `held`, ends nothing and asks again once the session is
 * quiet. `--why <reason>` is the hold's reason, which the restart names if it gives up. Whichever of the
 * tab's answer and the restart's withdraw comes first wins.
 */
export async function clearClaim(args, runtime) {
    noPositionals(args);
    const answer = args.switches.has(HOLD_SWITCH) ? { kind: 'hold', why: args.flags.get(WHY_FLAG) } : { kind: 'claim' };
    const claudeSession = sessionIdOf(parseJson(await runtime.readStdin()));
    const problem = claudeSession === null || !isClaudeSessionId(claudeSession)
        ? 'no Claude Code session id on stdin'
        : await claimProblem(runtime, asksOf(runtime), claudeSession, answer);
    runtime.out.stdout(problem !== undefined ? `declined: ${problem}` : answer.kind === 'hold' ? CLAIM_HELD : CLAIM_TAKEN);
    return EXIT.ok;
}
