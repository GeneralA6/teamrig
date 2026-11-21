import { stringField } from "../core/guards.js";
import { BLOCK_START_WORDS, isBlockStartLine } from "../core/work-block.js";
import { isPushedPrompt, isStopFeedback } from "./turn-origin.js";
/**
 * What started a turn: the owner, a peer's message, a notification (a finished background task or a
 * helper's handback), a scheduled wake, a subagent's own prompt, or anything else.
 */
export const TURN_TRIGGERS = ['owner', 'peer', 'notification', 'scheduled', 'subagent', 'other'];
/** A tool call from its id, name and input, as a transcript line or a hook payload carries them. */
export function toolUseFrom(id, name, input) {
    const path = input === undefined ? undefined : toolPathOf(input);
    const skill = name === SKILL_TOOL && input !== undefined ? stringField(input, 'skill') : undefined;
    const url = name === WEB_FETCH_TOOL && input !== undefined ? stringField(input, 'url') : undefined;
    const agent = name === AGENT_TOOL ? ((input === undefined ? undefined : stringField(input, 'subagent_type')) ?? DEFAULT_AGENT) : undefined;
    return {
        id,
        name,
        command: input === undefined ? undefined : stringField(input, 'command'),
        ...(path === undefined ? {} : { path }),
        ...(skill === undefined ? {} : { skill }),
        ...(agent === undefined ? {} : { agent }),
        ...(url === undefined ? {} : { url }),
        ...(input?.['run_in_background'] === true ? { background: true } : {}),
    };
}
/** The tool that loads a skill: its input's `skill` names it. */
export const SKILL_TOOL = 'Skill';
/** The tool that starts a subagent: its input's `subagent_type` names the agent type. */
export const AGENT_TOOL = 'Agent';
/** The agent type an `Agent` call with no `subagent_type` runs. */
const DEFAULT_AGENT = 'general-purpose';
/** The tool that reads a web page: its input's `url` names it. */
export const WEB_FETCH_TOOL = 'WebFetch';
const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/g;
/** A register task id as a word: `T` and a number with no leading zero. */
const TASK_MENTION = /\bT[1-9]\d*\b/g;
/** The slash commands a prompt's text runs, without the slash, in order. */
export function commandsIn(text) {
    return Array.from(text.matchAll(COMMAND_NAME), (match) => match[1] ?? '').filter((name) => name !== '');
}
/** The task ids a prompt's text names, each once, in order. */
export function tasksIn(text) {
    return [...new Set(text.match(TASK_MENTION) ?? [])];
}
/** The file or folder a tool's input names: `file_path`, `notebook_path` or a search's `path`. */
export function toolPathOf(input) {
    return stringField(input, 'file_path') ?? stringField(input, 'notebook_path') ?? stringField(input, 'path');
}
const TOOL_USE_ID = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;
/** A reply entry as a call; undefined for a reply without readable usage. */
export function callLineOf(entry) {
    const { usage, model, effort } = entry;
    if (usage === undefined || usage === 'unreadable') {
        return undefined;
    }
    return {
        kind: 'call',
        key: entry.key,
        at: entry.at,
        mainThread: entry.thread === 'main',
        usage,
        tools: entry.calls.map((call) => toolUseFrom(call.id, call.name, call.input)),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
    };
}
/** An input's text: the plain content, else its text parts joined. */
function inputText(entry) {
    return entry.text ?? entry.parts.join('');
}
/**
 * What started the turn an input begins, from the two origin marks the host writes, else from the text a peer
 * message or a notification starts with.
 */
function inputTrigger(entry, text) {
    if (entry.continuation) {
        return 'continuation';
    }
    if (entry.thread === 'helper') {
        return 'subagent';
    }
    const { origin, turnOrigin } = entry;
    if (turnOrigin === 'scheduled') {
        return 'scheduled';
    }
    if (origin === 'handback') {
        return 'notification';
    }
    if (origin === 'peer') {
        return 'peer';
    }
    if (origin === 'notification' || turnOrigin === 'notification' || text.includes('<task-notification')) {
        return 'notification';
    }
    if (origin === 'person' || turnOrigin === 'person') {
        return 'owner';
    }
    return turnOrigin === 'peer' || text.startsWith('<cross-session-message') ? 'peer' : 'other';
}
/** A prompt line; only a notification's own `<tool-use-id>` names the call it answers, never one a message quotes. */
function promptLineOf(entry) {
    const text = inputText(entry);
    const trigger = inputTrigger(entry, text);
    const answers = trigger === 'notification' ? TOOL_USE_ID.exec(text)?.[1] : undefined;
    const tasks = tasksIn(text);
    return {
        kind: 'prompt',
        at: entry.at,
        trigger,
        commands: commandsIn(text),
        ...(answers === undefined ? {} : { answers }),
        ...(tasks.length === 0 ? {} : { tasks }),
        ...(isPushedPrompt(text) ? { pushed: true } : {}),
    };
}
/** An input as results or a prompt; undefined for text the host adds itself. A result naming no call is left out. */
function inputLineOf(entry) {
    if (entry.meta) {
        return undefined;
    }
    const results = entry.results.flatMap((result) => (result.call === undefined ? [] : [{ id: result.call, isError: result.isError, text: result.text }]));
    return results.length > 0 ? { kind: 'results', at: entry.at, results } : promptLineOf(entry);
}
/**
 * A hook's note written as the session started, whose text holds a work-block start line (core/work-block.ts);
 * undefined for any other note.
 */
function startNoteLineOf(entry) {
    return entry.atStart && entry.texts.some((text) => text.split('\n').some(isBlockStartLine)) ? { kind: 'start-note', at: entry.at } : undefined;
}
/** The entry kinds the meter counts; a hook's note is asked for only on a line that can hold a work-block start. */
const COUNTED_KINDS = ['reply', 'input', 'compact'];
const COUNTED_KINDS_AND_NOTES = [...COUNTED_KINDS, 'hook-note'];
/**
 * One transcript line as what the meter counts; undefined for the many lines it ignores (notes other than a
 * work-block start, a reply without readable usage, text the host adds itself, every other kind) and for a damaged
 * or torn line. The reader is asked for the few kinds counted, so most other lines are never parsed.
 */
export function transcriptLineOf(reader, raw) {
    const entry = reader.entry(raw, raw.includes(BLOCK_START_WORDS) ? COUNTED_KINDS_AND_NOTES : COUNTED_KINDS);
    switch (entry?.kind) {
        case 'reply':
            return callLineOf(entry);
        case 'input':
            return inputLineOf(entry);
        case 'compact':
            return { kind: 'compact', at: entry.at };
        case 'hook-note':
            return startNoteLineOf(entry);
        default:
            return undefined;
    }
}
/**
 * A Stop hook's push, which the host writes as its own text. `transcriptLineOf` skips such lines and must go on
 * skipping them, or the meter's turn counts move: only the rollup, which needs to see the turn start, reads this.
 */
export function stopFeedbackOf(reader, raw) {
    const entry = reader.entry(raw, ['input']);
    return entry?.kind === 'input' && entry.meta && isStopFeedback(inputText(entry)) ? promptLineOf(entry) : undefined;
}
