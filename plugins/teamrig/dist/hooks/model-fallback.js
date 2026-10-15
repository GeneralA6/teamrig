import { recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
/**
 * How much of the transcript's end the Stop hook reads for a switch. Claude Code writes the switch
 * when it happens, so a long turn's tool calls come after it before the turn's Stop.
 */
export const FALLBACK_TAIL_BYTES = 1024 * 1024;
/** Only a line naming a fallback model is worth parsing as a switch. */
const FALLBACK_MARKER = '"fallbackModel"';
const REPLY_MARKER = '"assistant"';
function fallbackOfEntry(entry) {
    if (entry['type'] !== 'system' || entry['isSidechain'] === true) {
        return undefined;
    }
    const from = stringField(entry, 'originalModel');
    const to = stringField(entry, 'fallbackModel');
    if (from === undefined || to === undefined || from === to) {
        return undefined;
    }
    return { id: stringField(entry, 'uuid') ?? `${from}>${to}`, from, to, category: stringField(entry, 'apiRefusalCategory') };
}
/** The model of a main-thread reply; undefined for any other entry and for one Claude Code made up (`<synthetic>`). */
function replyModelOf(entry) {
    if (entry['type'] !== 'assistant' || entry['isSidechain'] === true) {
        return undefined;
    }
    const message = recordField(entry, 'message');
    const model = message === undefined ? undefined : stringField(message, 'model');
    return model === undefined || model.startsWith('<') ? undefined : model;
}
/**
 * The session's last switch in transcript lines, while it still holds: undefined when there is none,
 * or a later main-thread reply came from another model (the user switched back). A `cut` text, the
 * tail of a longer file, may start mid-line, so its first line is skipped; damaged lines are skipped too.
 */
export function lastFallbackOf(text, cut) {
    const lines = text.split('\n');
    const first = cut ? 1 : 0;
    let latestModel;
    for (let index = lines.length - 1; index >= first; index -= 1) {
        const line = lines[index] ?? '';
        const entry = line.includes(FALLBACK_MARKER) || (latestModel === undefined && line.includes(REPLY_MARKER)) ? parseObject(line) : undefined;
        if (entry === undefined) {
            continue;
        }
        const fallback = fallbackOfEntry(entry);
        if (fallback !== undefined) {
            return latestModel === undefined || latestModel === fallback.to ? fallback : undefined;
        }
        latestModel ??= replyModelOf(entry);
    }
    return undefined;
}
/** The last switch from the transcript's last `FALLBACK_TAIL_BYTES`, never the whole file; undefined when the transcript is missing. */
export async function readLastFallback(files, transcript) {
    const text = await files.readTail(transcript, FALLBACK_TAIL_BYTES);
    return text === undefined ? undefined : lastFallbackOf(text, Buffer.byteLength(text, 'utf8') >= FALLBACK_TAIL_BYTES);
}
/**
 * The line that tells the user Claude Code switched the session's model, with the command that
 * switches back: to `wanted`, the team config's model, else the model the session ran before.
 */
export function fallbackLine(name, fallback, wanted) {
    const why = fallback.category === undefined ? '' : ` (${fallback.category})`;
    return `MODEL ${name} now runs model ${fallback.to}, not ${fallback.from}: Claude Code switched after its safeguards stopped a reply${why} and keeps it for this session; type /model ${wanted ?? fallback.from} to switch back`;
}
