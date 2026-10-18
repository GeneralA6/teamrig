import { isRecord, stringField } from "../core/guards.js";
/**
 * How much of a transcript's end is searched for the session's title, and for its context size at a
 * task boundary (`refresh/usage.ts`): many turns' worth, while a long session's transcript is never
 * read whole on every prompt.
 */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** The transcript entry Claude Code writes when the user names the session (`--name`, `/rename`). */
const CUSTOM_TITLE = 'custom-title';
/** The transcript entry holding the title Claude Code made up from the conversation. */
const AI_TITLE = 'ai-title';
function parseLine(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
/** The newest non-blank `field` of the `type` entries in transcript lines, trimmed. A torn first line of a tail is skipped. */
function newestTitleOf(text, type, field) {
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        // Most lines are turns; only a line naming the entry type is worth parsing.
        const entry = line.includes(type) ? parseLine(line) : undefined;
        const title = isRecord(entry) && entry['type'] === type ? stringField(entry, field)?.trim() : undefined;
        if (title !== undefined && title !== '') {
            return title;
        }
    }
    return undefined;
}
/**
 * The newest title the user gave the session, from transcript lines: only `custom-title` entries
 * count, never a title Claude Code made up. A torn first line of a tail is skipped.
 */
export function customTitleOf(text) {
    return newestTitleOf(text, CUSTOM_TITLE, 'customTitle');
}
/**
 * The newest title Claude Code made up for the session (`ai-title` entries), from transcript lines. It
 * only describes the conversation, as a tab's topic (tabs/status.ts): it never names the session.
 */
export function aiTitleOf(text) {
    return newestTitleOf(text, AI_TITLE, 'aiTitle');
}
/**
 * The title of the Claude Code session a hook runs for: the payload's `session_title`, else the
 * newest `custom-title` near the end of its transcript. Undefined when the user never named it.
 */
export async function sessionTitleOf(payload, files) {
    if (!isRecord(payload)) {
        return undefined;
    }
    const title = stringField(payload, 'session_title')?.trim();
    if (title !== undefined && title !== '') {
        return title;
    }
    const transcript = stringField(payload, 'transcript_path');
    const text = transcript === undefined || transcript === '' ? undefined : await files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
    return text === undefined ? undefined : customTitleOf(text);
}
