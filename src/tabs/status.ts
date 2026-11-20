import { aiTitleOf, customTitleOf } from '../names/title.ts';
import type { EntryKind, HookEvent, InputEntry, TranscriptReader } from '../ports/host/index.ts';
import type { BackgroundKind } from '../refresh/running.ts';
import type { TabState } from './state.ts';

/**
 * Tab status: a colored circle before the terminal tab's title that shows what its session is doing,
 * set from Claude Code's hook events through their `terminalSequence` output. The circle is the one
 * pictograph teamrig prints (T460, the owner's ask): a tab title is plain text, so its color can only
 * come from the character itself.
 */

/**
 * What a hook event does to the tab: shows a state, gives the title back to the terminal (`reset`, as
 * the session ends), or leaves it as it is (undefined).
 */
export type TabChange = TabState | 'reset' | undefined;

/**
 * Each state's circle: green waits for a prompt, yellow works, orange waits on the user's answer to a prompt, blue
 * waits on the user's decision asked in plain text, red hit an API error, purple compacts.
 */
export const TAB_CIRCLES: Readonly<Record<TabState, string>> = {
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
const HELPER_KINDS: ReadonlySet<BackgroundKind> = new Set(['helper', 'workflow']);

/** The one kind of transcript entry a first prompt can be. */
const KINDS: readonly EntryKind[] = ['input'];

/** The SessionStart sources that open a session on an empty prompt; a compaction's start falls mid-turn. */
const OPENING_SOURCES: ReadonlySet<string> = new Set(['startup', 'resume', 'clear']);

/** A prompt that is a slash command: most run in the tab without a turn, so no Stop would end a working state. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:.-]*(\s|$)/;

/**
 * What starts the line of a turn's last message that puts a decision to the user (T513): the turn then ends on
 * `decision` instead of `ready`, until the next prompt. A fixed marker, so no model guesses whether a message asks.
 */
export const DECISION_MARKER = 'Decision needed:';

/** A line that opens with the marker, after optional bold or heading markup; never indented, quoted or listed. */
const DECISION_LINE = new RegExp(String.raw`^(?:\*\*|#{1,6} +)?${DECISION_MARKER}`);

/** A line that opens or closes a fenced code block: a marker inside one is shown, not asked. */
const FENCE = /^ {0,3}(```|~~~)/;

/** C0 and C1 controls and DEL: inside the title, one would end the sequence early or make Claude Code refuse it. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** What the tab's state reads of a hook event. */
export type TabEvent = Pick<HookEvent, 'name' | 'source' | 'prompt' | 'call' | 'lastReply' | 'trigger'>;

/** What a hook event does to the tab, from its name and the fields that event carries. */
export function tabChangeOf(event: TabEvent): TabChange {
  switch (event.name) {
    case 'session-start':
      return OPENING_SOURCES.has(event.source ?? '') ? 'ready' : undefined;
    case 'prompt':
      return SLASH_COMMAND.test(event.prompt ?? '') ? 'ready' : 'working';
    case 'tool-start':
      // Only a call that stops the turn to ask the user: a question, or a plan to approve.
      return event.call?.kind === 'ask' ? 'waiting' : undefined;
    case 'permission-prompt':
    case 'form-start':
      return 'waiting';
    case 'tool-end':
    case 'tool-failed':
    case 'form-end':
    case 'helper-start':
      return 'working';
    case 'stop':
      return asksDecision(event.lastReply) ? 'decision' : 'ready';
    case 'stop-failed':
      return 'error';
    case 'compact-start':
      return 'compacting';
    case 'compact-end':
      // A /compact the user typed ends there; an automatic one carries on with the turn it interrupted.
      return event.trigger === 'manual' ? 'ready' : 'working';
    case 'session-end':
      return 'reset';
    case 'helper-stop':
    case 'other':
      return undefined;
  }
}

/**
 * Whether a turn's last message puts a decision to the user: one of its lines outside a fenced code block opens
 * with `DECISION_MARKER`. The turn end's hook event carries the message as its last reply, so no transcript is read.
 */
export function asksDecision(message: string | undefined): boolean {
  return decisionLineOf(message) !== undefined;
}

/** The first line of a message that puts a decision to the user, as `asksDecision` finds it; undefined when none does. */
export function decisionLineOf(message: string | undefined): string | undefined {
  let fenced = false;
  for (const line of (message ?? '').split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
    } else if (!fenced && DECISION_LINE.test(line)) {
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
export function readyWaitsOnHelpers(event: Pick<HookEvent, 'name'>, change: TabChange): boolean {
  return change === 'ready' && event.name !== 'session-start';
}

/** Whether running background work includes a helper (`readRunningKinds`), so a ready tab still shows working. */
export function helpersRun(kinds: readonly BackgroundKind[]): boolean {
  return kinds.some((kind) => HELPER_KINDS.has(kind));
}

/**
 * Text fit for a tab title: control characters dropped as spaces, runs of white space made one space,
 * and at most `TITLE_MAX_CHARS` characters, a longer text cut with an ellipsis.
 */
export function titleText(text: string): string {
  const flat = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join('').trimEnd()}…` : flat;
}

/** The tab's title for a state: its circle, a space, then the text fit for a title. */
export function tabTitle(state: TabState, text: string): string {
  return `${TAB_CIRCLES[state]} ${titleText(text)}`;
}

/** A prompt that names what the session is about: not a slash command and not Claude Code's own markup (`<...`). */
function topicalPrompt(prompt: string | undefined): string | undefined {
  const text = prompt === undefined ? '' : titleText(prompt);
  return text === '' || text.startsWith('/') || text.startsWith('<') ? undefined : text;
}

/** The text of an input the host's transcript reader read: its string content, else its first text block. */
export function inputTextOf(entry: InputEntry): string | undefined {
  return entry.text ?? entry.parts[0];
}

/**
 * The session's first topical prompt in a whole transcript: the first message the user typed, past
 * slash commands, the host's own messages (meta, a compaction's summary, tool results) and helpers'.
 */
export function firstPromptOf(reader: TranscriptReader, text: string): string | undefined {
  for (const line of text.split('\n')) {
    const entry = reader.entry(line, KINDS);
    const typed = entry?.kind === 'input' && !entry.meta && entry.thread !== 'helper' && !entry.continuation;
    const prompt = typed ? topicalPrompt(inputTextOf(entry)) : undefined;
    if (prompt !== undefined) {
      return prompt;
    }
  }
  return undefined;
}

/** The end of a session's transcript as read: `whole` when the read reached its start. */
export interface TranscriptTail {
  readonly text: string;
  readonly whole: boolean;
}

/** The last segment of a folder path, either separator; undefined for a root or an empty path. */
function folderNameOf(path: string): string | undefined {
  return path.split(/[\\/]/).filter((part) => part !== '').pop();
}

/**
 * What the tab calls the session, the first of: the session's title (the hook event's, else the newest
 * the user gave in the transcript), the title Claude Code made up, the first prompt (from a whole
 * transcript, else this event's own), the folder's name, then `FALLBACK_TOPIC`. With no `reader` (a
 * host that keeps no transcript teamrig can read) the transcript's candidates are skipped.
 */
export function topicOf(reader: TranscriptReader | undefined, event: Pick<HookEvent, 'title' | 'prompt' | 'cwd'>, tail: TranscriptTail | undefined): string {
  const read = reader === undefined || tail === undefined ? undefined : { reader, tail };
  const candidates = [
    () => event.title,
    () => (read === undefined ? undefined : customTitleOf(read.reader, read.tail.text)),
    () => (read === undefined ? undefined : aiTitleOf(read.reader, read.tail.text)),
    () => (read?.tail.whole === true ? firstPromptOf(read.reader, read.tail.text) : undefined),
    () => topicalPrompt(event.prompt),
    () => folderNameOf(event.cwd ?? ''),
  ];
  for (const candidate of candidates) {
    const text = titleText(candidate() ?? '');
    if (text !== '') {
      return text;
    }
  }
  return FALLBACK_TOPIC;
}
