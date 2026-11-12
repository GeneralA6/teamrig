import { resolveKitHome } from "../../core/home.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { CLAIM_END, CLAIM_HELD, CLAIM_TAKEN, END_SWITCH, HOLD_SWITCH, isClaudeSessionId, WHY_FLAG } from "../../mod/clear-hand.js";
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
    if (outcome === CLAIM_END) {
        return 'the ask was already claimed to end the session';
    }
    return outcome === CLAIM_TAKEN || outcome === CLAIM_HELD ? `the ask was already ${outcome}` : 'the restart took its ask back';
}
/**
 * Wins the ask for this answer; undefined when it was answered first. A claim without `--end` of an `end`
 * ask comes from an older mod, which runs /clear on `taken` whatever the ask says: it takes the ask as a
 * /clear, so the restart never ends a tab that is clearing.
 */
async function won(asks, claudeSession, ask, answer) {
    switch (answer.kind) {
        case 'hold':
            return (await asks.hold(claudeSession, answer.why)) ? CLAIM_HELD : undefined;
        case 'end':
            return ask.mode === 'end' && (await asks.claimEnd(claudeSession)) ? CLAIM_END : undefined;
        case 'claim':
            return (await asks.claim(claudeSession)) ? CLAIM_TAKEN : undefined;
    }
}
/** Why the tab may not claim (or hold) its ask, or what it won once it has. */
async function claimOf(runtime, asks, claudeSession, answer) {
    const ask = await asks.ask(claudeSession);
    if (ask === undefined) {
        return { problem: 'no ask for this session' };
    }
    if (answer.kind === 'end' && ask.mode !== 'end') {
        return { problem: 'the ask is for a /clear, not an end' };
    }
    const kit = await openKit(runtime, ask.team);
    const store = new RefreshStore(runtime.files, kit.paths);
    const request = await store.restart(ask.id);
    if (request?.phase !== 'pending' || request.at !== ask.at || request.claudeSession !== claudeSession) {
        return { problem: 'the restart is no longer pending' };
    }
    const claimed = await won(asks, claudeSession, ask, answer);
    if (claimed === undefined) {
        return { problem: await answeredProblem(asks, claudeSession) };
    }
    // Held or ending: the request stays pending, so the restart waits for quiet and asks again, or ends the session.
    if (claimed === CLAIM_TAKEN) {
        // Claimed for a /clear: the request goes now, so a prompt typed before the /clear runs is not told it was cancelled.
        await store.clearRestart(ask.id);
    }
    return { claimed };
}
function tabAnswerOf(args) {
    if (args.switches.has(HOLD_SWITCH)) {
        return { kind: 'hold', why: args.flags.get(WHY_FLAG) };
    }
    return args.switches.has(END_SWITCH) ? { kind: 'end' } : { kind: 'claim' };
}
/**
 * `hook clear-claim`, run by the plugin's mod with `{"session_id": ...}` on stdin once it sees its tab's
 * ask while no turn runs: claims the ask while the restart it is for is still pending, and prints `taken`
 * (the mod then runs /clear) or `declined: <why>`. With `--hold` (a helper the /clear or an end could cut
 * off, a draft, the person or the band's count holds it) it holds the ask instead and prints `held`: the
 * request stays pending and the restart, seeing `held`, ends nothing and asks again once the session is
 * quiet. `--why <reason>` is the hold's reason, which the restart names if it gives up. With `--end` it
 * claims an ask in `end` mode and prints `end`: the request stays pending and the restart ends the session
 * and starts it again, as a /clear would keep its effort level. Whichever of the tab's answer and the
 * restart's withdraw comes first wins.
 */
export async function clearClaim(args, runtime) {
    noPositionals(args);
    const answer = tabAnswerOf(args);
    const claudeSession = sessionIdOf(parseJson(await runtime.readStdin()));
    const result = claudeSession === null || !isClaudeSessionId(claudeSession)
        ? { problem: 'no Claude Code session id on stdin' }
        : await claimOf(runtime, asksOf(runtime), claudeSession, answer);
    runtime.out.stdout('problem' in result ? `declined: ${result.problem}` : result.claimed);
    return EXIT.ok;
}
