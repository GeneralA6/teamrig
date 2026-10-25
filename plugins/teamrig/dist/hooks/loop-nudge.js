import { formatW } from "../budget/format.js";
import { parseTranscriptLine } from "../budget/line.js";
import { kindOf } from "../budget/patterns.js";
import { contextTokens, WEIGHTS } from "../budget/weights.js";
function stepKind(call) {
    const tool = call.tools.length === 1 ? call.tools[0] : undefined;
    const kind = tool === undefined ? undefined : kindOf(tool);
    return kind === 'other' ? undefined : kind;
}
function isEditKind(kind) {
    return kind === 'edit' || kind === 'editTest';
}
function isTestKind(kind) {
    return kind === 'testFull' || kind === 'testTargeted' || kind === 'editTest';
}
function turnOf(text, cut) {
    const lines = text.split('\n');
    let calls = [];
    let tasks = [];
    for (const raw of cut ? lines.slice(1) : lines) {
        const line = parseTranscriptLine(raw);
        if (line?.kind === 'prompt') {
            calls = [];
            tasks = line.tasks ?? [];
        }
        else if (line?.kind === 'call' && line.mainThread) {
            const last = calls.at(-1);
            if (last !== undefined && line.key !== undefined && last.key === line.key) {
                last.tools.push(...line.tools);
            }
            else {
                calls.push({ key: line.key, tools: [...line.tools], context: contextTokens(line.usage) });
            }
        }
    }
    return { calls, tasks };
}
/** The turn's calls, with `current` as the last one when the transcript has not got it yet. */
function callsWith(text, cut, current) {
    const { calls } = turnOf(text, cut);
    const written = current === undefined || calls.some((call) => call.tools.some((tool) => tool.id === current.id));
    if (!written) {
        calls.push({ key: undefined, tools: [current], context: calls.at(-1)?.context ?? 0 });
    }
    return calls;
}
/** The main thread's tool calls since the last prompt, `current` included. */
export function turnToolsOf(text, cut, current) {
    return callsWith(text, cut, current).flatMap((call) => call.tools);
}
/** The task ids the current turn's prompt names; none when the text starts inside the turn, past its prompt. */
export function turnTasksOf(text, cut) {
    return turnOf(text, cut).tasks;
}
/**
 * The run of single-step calls ending the current turn, from transcript text (`cut`: a tail that may
 * start mid-line, so its first line is skipped). `current` is the tool the hook fires for: when its
 * reply is not in the transcript yet, it counts as one more single-tool call.
 */
export function chainOf(text, cut, current) {
    const calls = callsWith(text, cut, current);
    const kinds = [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        const kind = call === undefined ? undefined : stepKind(call);
        if (kind === undefined) {
            break;
        }
        kinds.unshift(kind);
    }
    const editThenTest = kinds.some((kind, index) => index > 0 && isTestKind(kind) && isEditKind(kinds[index - 1] ?? 'other'));
    return { length: kinds.length, editThenTest, context: calls.at(-1)?.context ?? 0 };
}
/**
 * The one line for the model when the run reaches `at` calls, so each run gets it once; undefined
 * below or past it, and always when `at` is 0. It prices what batching saves: every call after the
 * first re-read the whole context.
 */
export function nudgeLine(chain, at) {
    if (at <= 0 || chain.length !== at) {
        return undefined;
    }
    const rereads = formatW((chain.length - 1) * chain.context * WEIGHTS.cacheRead);
    const fix = chain.editThenTest
        ? 'an edit and then its test went in separate calls: send an edit with its re-test in one message, and independent reads together'
        : 'put independent reads in one message, and an edit with its re-test';
    return `teamrig: ${chain.length} single-step calls in a row this turn (about ${rereads} W of re-reads at this context); ${fix}.`;
}
