import { errorMessage } from "../core/guards.js";
import { SecretScanner } from "../core/secrets.js";
import { postLine } from "../inbox/inbox.js";
import { WakeAsks } from "../wake/asks.js";
import { inboxDepsOf } from "./commands/inbox.js";
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
        await new WakeAsks(runtime.files, kit.paths.wakeAsks).post(line.to, { from: line.from, text, at });
    }
    catch (error) {
        return `posted to the inbox, but it does not wake ${line.to}: ${errorMessage(error)}`;
    }
    return undefined;
}
