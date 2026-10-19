import { isRecord, stringField } from "../../core/guards.js";
import { SecretScanner } from "../../core/secrets.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { cappedText } from "../../turn-log/entry.js";
import { REPLY_TAIL_BYTES, replyOf } from "../../turn-log/reply.js";
import { TurnLog } from "../../turn-log/store.js";
/** What SessionStart's `source` logs: a /clear or a compaction, which wipe what the tab showed. */
const WIPES = { clear: 'context cleared (/clear)', compact: 'context compacted' };
function entryOf(runtime, scope, said) {
    const { text, cut } = cappedText(new SecretScanner(scope.config.register.secretPatterns).redact(said.text));
    return {
        at: new Date(runtime.clock.now()).toISOString(),
        kind: said.kind,
        text,
        claude: said.claude,
        ...(cut || said.cut === true ? { truncated: true } : {}),
        ...(said.upTo === undefined ? {} : { upTo: said.upTo }),
    };
}
function logOf(runtime, scope) {
    return new TurnLog(runtime.files, scope.paths.turnLog);
}
/** UserPromptSubmit: the prompt the person sent; nothing with the log off or an empty prompt. */
export async function logPrompt(runtime, scope, payload) {
    const claude = sessionIdOf(payload);
    const prompt = isRecord(payload) ? stringField(payload, 'prompt') : undefined;
    if (!scope.config.turnLog.enabled || claude === null || prompt === undefined || prompt.trim() === '') {
        return;
    }
    await logOf(runtime, scope).append(scope.id, entryOf(runtime, scope, { kind: 'prompt', claude, text: prompt }));
}
/**
 * The turn's reply from the transcript, ending with the message Claude Code gives the Stop hook
 * (`last_assistant_message`) when the transcript does not hold it yet; undefined when the turn wrote no text.
 * A reply of that message alone keeps `after`, the last entry an earlier reply took.
 */
function replyWithLast(reply, last, after) {
    const base = reply === undefined ? undefined : { text: reply.text, cut: reply.cut, upTo: reply.upTo };
    const message = last?.trim();
    if (message === undefined || message === '' || base?.text.trimEnd().endsWith(message) === true) {
        return base;
    }
    return base === undefined ? { text: message, cut: false, upTo: after } : { ...base, text: `${base.text}\n\n${message}` };
}
/**
 * Stop: the reply the person saw since the last one logged. A stop that a hook sent back (`stop_hook_active`)
 * ends part of a turn, so a later stop of the same turn starts after the last entry this one took (`upTo`).
 */
export async function logReply(runtime, scope, payload) {
    const claude = sessionIdOf(payload);
    const transcript = stringField(payload, 'transcript_path');
    if (!scope.config.turnLog.enabled || claude === null) {
        return;
    }
    const log = logOf(runtime, scope);
    const last = await log.last(scope.id);
    const after = last?.kind === 'reply' && last.claude === claude ? last.upTo : undefined;
    const tail = transcript === undefined ? undefined : await runtime.files.readTail(transcript, REPLY_TAIL_BYTES);
    const fromTranscript = tail === undefined ? undefined : replyOf(tail, after, Buffer.byteLength(tail, 'utf8') < REPLY_TAIL_BYTES);
    const reply = replyWithLast(fromTranscript, stringField(payload, 'last_assistant_message'), after);
    if (reply === undefined) {
        return;
    }
    const { text, cut, upTo } = reply;
    await log.append(scope.id, entryOf(runtime, scope, { kind: 'reply', claude, text, cut, ...(upTo === undefined ? {} : { upTo }) }));
}
/**
 * SessionStart: marks a /clear or a compaction, which wipe what the tab showed, and removes every session's
 * hours past `turnLog.keepHours` (folder listings only).
 */
export async function logStart(runtime, scope, payload) {
    if (!scope.config.turnLog.enabled) {
        return;
    }
    const log = logOf(runtime, scope);
    const claude = sessionIdOf(payload);
    const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
    const wipe = source === undefined ? undefined : WIPES[source];
    if (claude !== null && wipe !== undefined) {
        await log.append(scope.id, entryOf(runtime, scope, { kind: 'clear', claude, text: wipe }));
    }
    await log.prune(runtime.clock.now(), scope.config.turnLog.keepHours);
}
