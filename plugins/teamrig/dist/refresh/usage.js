import { callLineOf } from "../budget/line.js";
import { TRANSCRIPT_TAIL_BYTES } from "../names/title.js";
/**
 * The bytes `contextEstimateOf` counts as one token in the lines after the last reply: fewer than the four or so that
 * English and JSON take, and the lines carry JSON the model never reads, so the estimate errs high. A compaction
 * held up to a ceiling on it lets go early rather than late.
 */
export const ESTIMATE_BYTES_PER_TOKEN = 3;
/**
 * The context of one transcript line: what the host's meter says a main-thread reply read. Undefined
 * for any other line, a helper thread's reply, damaged usage, and a reply that read nothing, such as one the host
 * made up itself. The reader is asked for replies only, so most lines, prompts and tool results, are never parsed;
 * the reply's usage is read as the meter reads it (`callLineOf`), so both read a reply the same way.
 */
function contextOf(source, line) {
    const entry = source.reader.entry(line, ['reply']);
    const call = entry?.kind === 'reply' ? callLineOf(entry) : undefined;
    const total = call === undefined || !call.mainThread ? 0 : source.usage.contextReading(call.usage);
    return total > 0 ? total : undefined;
}
/** The last main-thread reply's context and the index of its line, from line `first` on; undefined when no line tells. */
function lastContextOf(source, lines, first) {
    for (let index = lines.length - 1; index >= first; index -= 1) {
        const tokens = contextOf(source, lines[index] ?? '');
        if (tokens !== undefined) {
            return { tokens, index };
        }
    }
    return undefined;
}
/**
 * The session's context size from transcript lines: that of the last main-thread reply. A `cut`
 * text, the tail of a longer file, may start mid-line, so its first line is skipped; damaged lines
 * are skipped too. Undefined when no line tells, which never asks for a refresh.
 */
export function contextTokensOf(source, text, cut) {
    return lastContextOf(source, text.split('\n'), cut ? 1 : 0)?.tokens;
}
/**
 * The context the next reply would read, for a hook Claude Code does not tell it (the classic PreCompact): the last
 * main-thread reply's context, plus that reply and every line after it at `ESTIMATE_BYTES_PER_TOKEN`, since its
 * output and the tool results since are read next. A prompt too long for the window sits in those lines, so it
 * reads past any ceiling. Undefined when no line tells, as for `contextTokensOf`.
 */
export function contextEstimateOf(source, text, cut) {
    const lines = text.split('\n');
    const last = lastContextOf(source, lines, cut ? 1 : 0);
    if (last === undefined) {
        return undefined;
    }
    const since = Buffer.byteLength(lines.slice(last.index).join('\n'), 'utf8');
    return last.tokens + Math.ceil(since / ESTIMATE_BYTES_PER_TOKEN);
}
/**
 * `read` over the transcript's last `TRANSCRIPT_TAIL_BYTES`, never the whole file; undefined when
 * the transcript is missing. A tail as long as the limit is taken as cut (a file of exactly that
 * size only loses its first line).
 */
async function fromTail(files, transcript, read) {
    const text = await files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
    return text === undefined ? undefined : read(text, Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES);
}
/** The context size from the transcript's tail (`contextTokensOf`); undefined when it is missing or no reply there has usage. */
export function readContextTokens(source, files, transcript) {
    return fromTail(files, transcript, (text, cut) => contextTokensOf(source, text, cut));
}
/** The context estimate from the transcript's tail (`contextEstimateOf`); undefined when it is missing or no reply there has usage. */
export function readContextEstimate(source, files, transcript) {
    return fromTail(files, transcript, (text, cut) => contextEstimateOf(source, text, cut));
}
