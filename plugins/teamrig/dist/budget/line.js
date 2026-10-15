import { isRecord, recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { usageOf } from "./weights.js";
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
    const input = recordField(block, 'input');
    return { id, name, command: input === undefined ? undefined : stringField(input, 'command') };
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
/** A user entry as results or a prompt; undefined for any other entry and for text Claude Code adds itself. */
function userLineOf(entry) {
    const message = entry['type'] === 'user' && entry['isMeta'] !== true ? recordField(entry, 'message') : undefined;
    if (message === undefined) {
        return undefined;
    }
    const results = blocksOf(message).flatMap((block) => toolResultOf(block) ?? []);
    const at = timeOf(entry);
    return results.length > 0 ? { kind: 'results', at, results } : { kind: 'prompt', at };
}
/**
 * One transcript line as what the meter counts; undefined for the many lines it ignores (system
 * notes, attachments, snapshots) and for a damaged or torn line. A cheap text test runs first, so
 * only a line that can be a reply or a user line is parsed.
 */
export function parseTranscriptLine(raw) {
    if (!raw.includes('"usage"') && !raw.includes('"type":"user"')) {
        return undefined;
    }
    const entry = parseObject(raw);
    if (entry === undefined) {
        return undefined;
    }
    return callOf(entry) ?? userLineOf(entry);
}
