import { SecretScanner } from "../../core/secrets.js";
import { cappedText } from "../../turn-log/entry.js";
import { REPLY_TAIL_BYTES, replyOf } from "../../turn-log/reply.js";
import { TurnLog } from "../../turn-log/store.js";
import { WakePrompts } from "../../wake/prompts.js";
import { transcriptsIfKept } from "../host.js";
/** What a session start's `source` logs: a /clear or a compaction, which wipe what the tab showed. */
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
        ...(said.from === undefined ? {} : { from: said.from }),
    };
}
function logOf(runtime, scope) {
    return new TurnLog(runtime.files, scope.paths.turnLog);
}
/**
 * UserPromptSubmit: the prompt the person sent, or the wake teamrig submitted in that tab, marked `from: teamrig`;
 * nothing with the log off or an empty prompt.
 */
export async function logPrompt(runtime, scope, { session, prompt }) {
    if (!scope.config.turnLog.enabled || session === undefined || prompt === undefined || prompt.trim() === '') {
        return;
    }
    const woke = await new WakePrompts(runtime.files, scope.paths.wake).take(scope.id, { tab: session, text: prompt });
    const said = { kind: 'prompt', claude: session, text: prompt, ...(woke ? { from: 'teamrig' } : {}) };
    await logOf(runtime, scope).append(scope.id, entryOf(runtime, scope, said));
}
/**
 * The turn's reply from the transcript, ending with the last reply the turn end's hook event names when the
 * transcript does not hold it yet; undefined when the turn wrote no text.
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
 * A turn's end: the reply the person saw since the last one logged. A stop that a hook sent back ends part of
 * a turn, so a later stop of the same turn starts after the last entry this one took (`upTo`). On a host whose
 * transcript teamrig cannot read, the reply is the last reply the event names alone.
 */
export async function logReply(runtime, scope, { session: claude, transcript, lastReply }) {
    if (!scope.config.turnLog.enabled || claude === undefined) {
        return;
    }
    const log = logOf(runtime, scope);
    const last = await log.last(scope.id);
    const after = last?.kind === 'reply' && last.claude === claude ? last.upTo : undefined;
    const reader = transcriptsIfKept(runtime);
    const tail = reader === undefined || transcript === undefined ? undefined : await runtime.files.readTail(transcript, REPLY_TAIL_BYTES);
    const fromTranscript = reader === undefined || tail === undefined ? undefined : replyOf(reader, tail, after, Buffer.byteLength(tail, 'utf8') < REPLY_TAIL_BYTES);
    const reply = replyWithLast(fromTranscript, lastReply, after);
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
export async function logStart(runtime, scope, { session, source }) {
    if (!scope.config.turnLog.enabled) {
        return;
    }
    const log = logOf(runtime, scope);
    const wipe = source === undefined ? undefined : WIPES[source];
    if (session !== undefined && wipe !== undefined) {
        await log.append(scope.id, entryOf(runtime, scope, { kind: 'clear', claude: session, text: wipe }));
    }
    await log.prune(runtime.clock.now(), scope.config.turnLog.keepHours);
}
