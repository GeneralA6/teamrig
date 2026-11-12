import { isRecord, recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { aiTitleOf, customTitleOf } from "../names/title.js";
/**
 * Each state's circle: green waits for a prompt, yellow works, orange waits on the user's answer to a prompt, blue
 * waits on the user's decision asked in plain text, red hit an API error, purple compacts.
 */
export const TAB_CIRCLES = {
    ready: '🟢',
    working: '🟡',
    waiting: '🟠',
    decision: '🔵',
    error: '🔴',
    compacting: '🟣',
};
/** The most characters (code points) a title's text shows, so the circle and the start of the text stay in view. */
export const TITLE_MAX_CHARS = 40;
/** The tab's text when nothing better names the session. */
export const FALLBACK_TOPIC = 'Claude Code';
/** The background work that keeps a tab working past its turn's end: helpers, and the workflows that run them. */
const HELPER_KINDS = new Set(['helper', 'workflow']);
/** The tools that stop a turn to ask the user: a question, or a plan to approve. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** The SessionStart sources that open a session on an empty prompt; a compaction's start falls mid-turn. */
const OPENING_SOURCES = new Set(['startup', 'resume', 'clear']);
/** A prompt that is a slash command: most run in the tab without a turn, so no Stop would end a working state. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:.-]*(\s|$)/;
/**
 * What starts the line of a turn's last message that puts a decision to the user (T513): the turn then ends on
 * `decision` instead of `ready`, until the next prompt. A fixed marker, so no model guesses whether a message asks.
 */
export const DECISION_MARKER = 'Decision needed:';
/** A line that opens with the marker, after optional bold or heading markup; never indented, quoted or listed. */
const DECISION_LINE = new RegExp(String.raw `^(?:\*\*|#{1,6} +)?${DECISION_MARKER}`);
/** A line that opens or closes a fenced code block: a marker inside one is shown, not asked. */
const FENCE = /^ {0,3}(```|~~~)/;
/** C0 and C1 controls and DEL: inside the title, one would end the sequence early or make Claude Code refuse it. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
/** What a hook event does to the tab, from its `hook_event_name` and the fields that event carries. */
export function tabChangeOf(payload) {
    switch (stringField(payload, 'hook_event_name')) {
        case 'SessionStart':
            return OPENING_SOURCES.has(stringField(payload, 'source') ?? '') ? 'ready' : undefined;
        case 'UserPromptSubmit':
            return SLASH_COMMAND.test(stringField(payload, 'prompt') ?? '') ? 'ready' : 'working';
        case 'PreToolUse':
            return ASKING_TOOLS.has(stringField(payload, 'tool_name') ?? '') ? 'waiting' : undefined;
        case 'PermissionRequest':
        case 'Elicitation':
            return 'waiting';
        case 'PostToolUse':
        case 'PostToolUseFailure':
        case 'ElicitationResult':
        case 'SubagentStart':
            return 'working';
        case 'Stop':
            return asksDecision(stringField(payload, 'last_assistant_message')) ? 'decision' : 'ready';
        case 'StopFailure':
            return 'error';
        case 'PreCompact':
            return 'compacting';
        case 'PostCompact':
            // A /compact the user typed ends there; an automatic one carries on with the turn it interrupted.
            return stringField(payload, 'trigger') === 'manual' ? 'ready' : 'working';
        case 'SessionEnd':
            return 'reset';
        default:
            return undefined;
    }
}
/**
 * Whether a turn's last message puts a decision to the user: one of its lines outside a fenced code block opens
 * with `DECISION_MARKER`. Claude Code gives the message to Stop as `last_assistant_message`, so no transcript is read.
 */
export function asksDecision(message) {
    return decisionLineOf(message) !== undefined;
}
/** The first line of a message that puts a decision to the user, as `asksDecision` finds it; undefined when none does. */
export function decisionLineOf(message) {
    let fenced = false;
    for (const line of (message ?? '').split(/\r?\n/)) {
        if (FENCE.test(line)) {
            fenced = !fenced;
        }
        else if (!fenced && DECISION_LINE.test(line)) {
            return line;
        }
    }
    return undefined;
}
/**
 * Whether this event's `ready` must first look for helpers still running, which keep the tab working:
 * at a turn's end they run on in the background. A session that just started has none of its own (a
 * resumed one lost them with its old process, though its transcript never says they ended).
 */
export function readyWaitsOnHelpers(payload, change) {
    return change === 'ready' && stringField(payload, 'hook_event_name') !== 'SessionStart';
}
/** Whether running background work includes a helper (`readRunningKinds`), so a ready tab still shows working. */
export function helpersRun(kinds) {
    return kinds.some((kind) => HELPER_KINDS.has(kind));
}
/**
 * Text fit for a tab title: control characters dropped as spaces, runs of white space made one space,
 * and at most `TITLE_MAX_CHARS` characters, a longer text cut with an ellipsis.
 */
export function titleText(text) {
    const flat = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join('').trimEnd()}…` : flat;
}
/** The tab's title for a state: its circle, a space, then the text fit for a title. */
export function tabTitle(state, text) {
    return `${TAB_CIRCLES[state]} ${titleText(text)}`;
}
/** A prompt that names what the session is about: not a slash command and not Claude Code's own markup (`<...`). */
function topicalPrompt(prompt) {
    const text = prompt === undefined ? '' : titleText(prompt);
    return text === '' || text.startsWith('/') || text.startsWith('<') ? undefined : text;
}
/** The text of a user entry's message: its string content, else its first text block. */
export function messageTextOf(entry) {
    const content = recordField(entry, 'message')?.['content'];
    if (typeof content === 'string') {
        return content;
    }
    const block = Array.isArray(content) ? content.find((item) => isRecord(item) && item['type'] === 'text') : undefined;
    return isRecord(block) ? stringField(block, 'text') : undefined;
}
/**
 * The session's first topical prompt in a whole transcript: the first message the user typed, past
 * slash commands, Claude Code's own messages (meta, a compaction's summary, tool results) and helpers'.
 */
export function firstPromptOf(text) {
    for (const line of text.split('\n')) {
        const entry = line.includes('"user"') ? parseObject(line) : undefined;
        const typed = entry !== undefined && entry['type'] === 'user' && entry['isMeta'] !== true && entry['isSidechain'] !== true && entry['isCompactSummary'] !== true;
        const prompt = typed ? topicalPrompt(messageTextOf(entry)) : undefined;
        if (prompt !== undefined) {
            return prompt;
        }
    }
    return undefined;
}
/** The last segment of a folder path, either separator; undefined for a root or an empty path. */
function folderNameOf(path) {
    return path.split(/[\\/]/).filter((part) => part !== '').pop();
}
/**
 * What the tab calls the session, the first of: the session's title (the payload's, else the newest
 * the user gave in the transcript), the title Claude Code made up, the first prompt (from a whole
 * transcript, else this event's own), the folder's name, then `FALLBACK_TOPIC`.
 */
export function topicOf(payload, tail) {
    const candidates = [
        () => stringField(payload, 'session_title'),
        () => (tail === undefined ? undefined : customTitleOf(tail.text)),
        () => (tail === undefined ? undefined : aiTitleOf(tail.text)),
        () => (tail?.whole === true ? firstPromptOf(tail.text) : undefined),
        () => topicalPrompt(stringField(payload, 'prompt')),
        () => folderNameOf(stringField(payload, 'cwd') ?? ''),
    ];
    for (const candidate of candidates) {
        const text = titleText(candidate() ?? '');
        if (text !== '') {
            return text;
        }
    }
    return FALLBACK_TOPIC;
}
