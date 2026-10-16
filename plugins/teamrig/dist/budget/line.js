import { isRecord, recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { usageOf } from "./weights.js";
/**
 * What started a turn: the owner, a peer's message, a notification (a finished background task or a
 * helper's handback), a scheduled wake, a subagent's own prompt, or anything else.
 */
export const TURN_TRIGGERS = ['owner', 'peer', 'notification', 'scheduled', 'subagent', 'other'];
function timeOf(entry) {
    const text = stringField(entry, 'timestamp');
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
function blocksOf(message) {
    const content = message['content'];
    return Array.isArray(content) ? content.filter(isRecord) : [];
}
function toolUseOf(block) {
    const id = stringField(block, 'id');
    const name = stringField(block, 'name');
    if (block['type'] !== 'tool_use' || id === undefined || name === undefined) {
        return undefined;
    }
    return toolUseFrom(id, name, recordField(block, 'input'));
}
/** A tool call from its id, name and input, as a transcript line or a hook payload carries them. */
export function toolUseFrom(id, name, input) {
    const path = input === undefined ? undefined : toolPathOf(input);
    return { id, name, command: input === undefined ? undefined : stringField(input, 'command'), ...(path === undefined ? {} : { path }) };
}
/** The file or folder a tool's input names: `file_path`, `notebook_path` or a search's `path`. */
export function toolPathOf(input) {
    return stringField(input, 'file_path') ?? stringField(input, 'notebook_path') ?? stringField(input, 'path');
}
/** A tool result's text: the string itself, or its text blocks joined by newlines. */
function resultText(block) {
    const content = block['content'];
    if (typeof content === 'string') {
        return content;
    }
    return Array.isArray(content)
        ? content
            .filter(isRecord)
            .map((part) => stringField(part, 'text') ?? '')
            .join('\n')
        : '';
}
function toolResultOf(block) {
    const id = stringField(block, 'tool_use_id');
    if (block['type'] !== 'tool_result' || id === undefined) {
        return undefined;
    }
    return { id, isError: block['is_error'] === true, text: resultText(block) };
}
/** An assistant entry as a call; undefined for any other entry and for a reply without readable usage. */
export function callOf(entry) {
    const message = entry['type'] === 'assistant' ? recordField(entry, 'message') : undefined;
    const usage = message === undefined ? undefined : usageOf(message);
    if (message === undefined || usage === undefined) {
        return undefined;
    }
    const id = stringField(message, 'id');
    const tools = blocksOf(message).flatMap((block) => toolUseOf(block) ?? []);
    return {
        kind: 'call',
        key: id === undefined ? undefined : `${id}|${stringField(entry, 'requestId') ?? ''}`,
        at: timeOf(entry),
        mainThread: entry['isSidechain'] === false,
        usage,
        tools,
    };
}
function promptText(message) {
    const content = message['content'];
    return typeof content === 'string' ? content : blocksOf(message).map((block) => stringField(block, 'text') ?? '').join('');
}
/**
 * What started the turn a user entry begins, from the `origin` and `turnOrigin` Claude Code writes, else
 * from the text a peer message or a notification starts with.
 */
function triggerOf(entry, message) {
    if (entry['isCompactSummary'] === true) {
        return 'continuation';
    }
    if (entry['isSidechain'] === true) {
        return 'subagent';
    }
    const origin = recordField(entry, 'origin');
    const kind = origin === undefined ? undefined : stringField(origin, 'kind');
    const turnOrigin = stringField(entry, 'turnOrigin');
    const text = promptText(message);
    if (turnOrigin === 'scheduled') {
        return 'scheduled';
    }
    if (kind === 'peer') {
        return origin?.['handback'] === true ? 'notification' : 'peer';
    }
    if (kind === 'task-notification' || turnOrigin === 'task_notification' || text.includes('<task-notification')) {
        return 'notification';
    }
    if (kind === 'human' || turnOrigin === 'human') {
        return 'owner';
    }
    return turnOrigin === 'peer' || text.startsWith('<cross-session-message') ? 'peer' : 'other';
}
/** A user entry as results or a prompt; undefined for any other entry and for text Claude Code adds itself. */
function userLineOf(entry) {
    const message = entry['type'] === 'user' && entry['isMeta'] !== true ? recordField(entry, 'message') : undefined;
    if (message === undefined) {
        return undefined;
    }
    const results = blocksOf(message).flatMap((block) => toolResultOf(block) ?? []);
    const at = timeOf(entry);
    return results.length > 0 ? { kind: 'results', at, results } : { kind: 'prompt', at, trigger: triggerOf(entry, message) };
}
/** A compaction's boundary line; undefined for any other entry. */
function compactOf(entry) {
    return entry['type'] === 'system' && entry['subtype'] === 'compact_boundary' ? { kind: 'compact', at: timeOf(entry) } : undefined;
}
/**
 * One transcript line as what the meter counts; undefined for the many lines it ignores (system
 * notes other than a compaction, attachments, snapshots) and for a damaged or torn line. A cheap text test runs first, so
 * only a line that can be a reply or a user line is parsed.
 */
export function parseTranscriptLine(raw) {
    if (!raw.includes('"usage"') && !raw.includes('"type":"user"') && !raw.includes('"compact_boundary"')) {
        return undefined;
    }
    const entry = parseObject(raw);
    if (entry === undefined) {
        return undefined;
    }
    return callOf(entry) ?? userLineOf(entry) ?? compactOf(entry);
}
