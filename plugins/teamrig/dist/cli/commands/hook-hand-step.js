import { stringField } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { handStepLintReason } from "../../hooks/hand-step-lint.js";
import { REPLY_TAIL_BYTES, replyOf } from "../../turn-log/reply.js";
/**
 * The text the person saw this turn: the model's text since the turn's start in the transcript's tail, and the
 * message Claude Code gives the Stop hook (`last_assistant_message`), which the transcript may not hold yet. A copy
 * of it twice changes nothing the lint reads.
 */
async function turnTextOf(runtime, payload) {
    const transcript = stringField(payload, 'transcript_path');
    const tail = transcript === undefined ? undefined : await runtime.files.readTail(transcript, REPLY_TAIL_BYTES);
    const reply = tail === undefined ? undefined : replyOf(tail, undefined, Buffer.byteLength(tail, 'utf8') < REPLY_TAIL_BYTES);
    return [reply?.text, stringField(payload, 'last_assistant_message')].filter((part) => part !== undefined).join('\n\n');
}
/**
 * The instruction for a team session whose turn handed the human a shell or JSON block or a call line with no pinned
 * sha256 (hand-step-lint.ts, core rule 11); none on a stop a hook already sent back, so a turn is asked once and a
 * reply that says the block only reads ends it.
 */
export async function handStepReasonOf(runtime, payload) {
    if (payload['stop_hook_active'] === true) {
        return undefined;
    }
    return handStepLintReason(await turnTextOf(runtime, payload), KIT_NAME);
}
