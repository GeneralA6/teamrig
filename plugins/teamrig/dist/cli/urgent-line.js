import { errorMessage } from "../core/guards.js";
import { SecretScanner } from "../core/secrets.js";
import { inboxLineOf, postLine } from "../inbox/inbox.js";
import { lineHash } from "../inbox/line-hash.js";
import { WakeAsks } from "../wake/asks.js";
import { inboxDepsOf } from "./commands/inbox.js";
import { RefusedError } from "./runtime.js";
/**
 * The ask that makes the posted line wake its receiver. An `atOnce` one is a timed ask due at its post time, bound to
 * the posted line by its hash, so the next wake check takes it while the line is unseen and drops it once the
 * receiver saw it at a prompt; any other is plain.
 */
export function urgentAskOf(line, text, at) {
    const ask = { from: line.from, text, at };
    return line.atOnce === true ? { ...ask, by: { at, line: lineHash(inboxLineOf(new Date(at), line.from, text)) } } : ask;
}
/**
 * Posts the line to its receiver's inbox, which stays the record, then a wake ask (src/wake/asks.ts), so the
 * receiver's next wake check wakes its idle tab with the line quoted; why it was not posted, or undefined once it is
 * both. A line the inbox refuses (a secret pattern, not one line) gets no ask either.
 */
export async function postUrgentLine(runtime, kit, config, line) {
    const at = runtime.clock.now();
    const text = line.text.trim();
    const secrets = new SecretScanner(config.register.secretPatterns);
    try {
        const refused = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, secrets, { to: line.to, from: line.from, text, now: new Date(at) });
        if (refused !== undefined) {
            return refused;
        }
    }
    catch (error) {
        return `not posted: ${errorMessage(error)}`;
    }
    try {
        await new WakeAsks(runtime.files, kit.paths.wakeAsks).post(line.to, urgentAskOf(line, text, at));
    }
    catch (error) {
        return `posted to the inbox, but it does not wake ${line.to}: ${errorMessage(error)}`;
    }
    return undefined;
}
/**
 * Posts `line` with an at-once ask (T2207), for a person waiting live on its receiver, unless an ask with the same
 * sender and text still waits for the receiver's tab (busy in a turn, or its next wake check not yet run): a second
 * press would only put the same line in its inbox again. Refused, naming the receiver as `shown`, when it is not posted.
 */
export async function postAtOnce(runtime, kit, config, line, shown) {
    const waiting = (await new WakeAsks(runtime.files, kit.paths.wakeAsks).read(line.to)).find(({ ask }) => ask?.from === line.from && ask.text === line.text)?.ask;
    if (waiting !== undefined) {
        return { kind: 'waiting', at: waiting.at };
    }
    const problem = await postUrgentLine(runtime, kit, config, { ...line, atOnce: true });
    if (problem !== undefined) {
        throw new RefusedError(`${shown} was not woken: ${problem}`);
    }
    return { kind: 'posted' };
}
