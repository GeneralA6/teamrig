import { stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
/** Enough of the transcript to hold a busy turn's replies between its tool results. */
export const REPLY_TAIL_BYTES = 1024 * 1024;
/** The content blocks of an entry's message; empty when it has none. */
function blocksOf(entry) {
    const message = entry['message'];
    if (typeof message !== 'object' || message === null || !('content' in message)) {
        return [];
    }
    const { content } = message;
    return Array.isArray(content) ? content : [];
}
function blockType(block) {
    return typeof block === 'object' && block !== null && 'type' in block && typeof block.type === 'string' ? block.type : undefined;
}
/**
 * Whether a `user` entry starts a turn: a prompt, a notification or a slash command's output. A tool
 * result is a `user` entry too, inside the turn, and so is a meta entry Claude Code adds as context.
 */
function startsTurn(entry) {
    if (entry['type'] !== 'user' || entry['isMeta'] === true) {
        return false;
    }
    const message = entry['message'];
    if (typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string') {
        return true;
    }
    return !blocksOf(entry).some((block) => blockType(block) === 'tool_result');
}
/** The text blocks of a model entry. */
function textsOf(entry) {
    return blocksOf(entry).flatMap((block) => blockType(block) === 'text' && typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' && block.text.trim() !== ''
        ? [block.text]
        : []);
}
/**
 * The reply of the transcript's last turn: the text the model wrote after the turn's start, or after
 * `after` (the last entry an earlier reply of the same turn took, as at a stop a hook sent back) when that
 * comes later. `whole` says the tail is the whole transcript, so a turn start missing from it is no cut.
 * Undefined when the model wrote no text since.
 */
export function replyOf(tail, after, whole) {
    const entries = tail.split('\n').flatMap((line) => {
        const entry = parseObject(line.trim());
        return entry === undefined ? [] : [entry];
    });
    let start = -1;
    entries.forEach((entry, index) => {
        if (startsTurn(entry) || (after !== undefined && stringField(entry, 'uuid') === after)) {
            start = index;
        }
    });
    const texts = [];
    let upTo;
    for (const entry of entries.slice(start + 1)) {
        if (entry['type'] !== 'assistant') {
            continue;
        }
        texts.push(...textsOf(entry));
        upTo = stringField(entry, 'uuid') ?? upTo;
    }
    if (texts.length === 0 || upTo === undefined) {
        return undefined;
    }
    return { text: texts.join('\n\n'), upTo, cut: start === -1 && !whole };
}
