import type { JsonRecord } from '../../core/guards.ts';

/**
 * The transcript reader port: a host's session log, one line at a time, as entries every reader of teamrig shares.
 * An adapter maps its host's own line shapes to these, so no reader names a field of the host's format. An entry
 * says what the line holds, not what a reader makes of it: where two readers weigh the same field differently
 * (a missing thread mark, a mixed origin), the entry keeps the states apart and each reader decides.
 */

/** The token counts of one model call. */
export interface CallUsage {
  readonly input: number;
  /** Cache writes that live 5 minutes. */
  readonly cacheWrite5m: number;
  /** Cache writes that live an hour. */
  readonly cacheWrite1h: number;
  /** Cache writes the host does not split by lifetime. */
  readonly cacheWriteUnsplit: number;
  readonly cacheRead: number;
  readonly output: number;
}

/** Whose line it is: the session's own thread, or a helper's (a subagent's). */
export type EntryThread = 'main' | 'helper';

/** What every entry carries. */
interface EntryBase {
  /** Epoch ms of the line; undefined when it has no readable time. */
  readonly at: number | undefined;
  /** The line's own id, and the id of the line it follows. */
  readonly id: string | undefined;
  readonly parent: string | undefined;
  /** The session the line says it belongs to. */
  readonly session: string | undefined;
  /** Undefined when the line does not say: readers differ on what an unmarked line counts as. */
  readonly thread: EntryThread | undefined;
  /** True for text the host wrote itself, not a person, a peer or a tool. */
  readonly meta: boolean;
  /**
   * True when the host wrote the line while the session ran as a background job, false while a person's tab ran it;
   * undefined when the line does not say.
   */
  readonly job: boolean | undefined;
}

/** Who or what an input came from, as the host marks it; `unknown` for a mark the adapter has no name for. */
export const INPUT_ORIGINS = ['person', 'peer', 'handback', 'notification', 'scheduled', 'unknown'] as const;
export type InputOrigin = (typeof INPUT_ORIGINS)[number];

/** What came back for one tool call. */
export interface ToolOutcome {
  /** The id of the call it answers; undefined when the line names none. */
  readonly call: string | undefined;
  readonly isError: boolean;
  /** Its text: the string itself, or its text parts joined by newlines. */
  readonly text: string;
  /**
   * What the host kept of the answer beside its text, in the tool's own fields, as a call's input is; undefined
   * when it kept none, or kept only text.
   */
  readonly data: JsonRecord | undefined;
}

/** What a tool's answer says of work left running after it, or stopped by it. */
export interface BackgroundMark {
  /** What it started: a shell command, a helper or another task; undefined when it started nothing. */
  readonly started: 'command' | 'helper' | 'task' | undefined;
  /** The id of what it started. */
  readonly task: string | undefined;
  /** The id of the running work it stopped. */
  readonly stopped: string | undefined;
}

/**
 * Everything given to the model: a prompt, a peer's message, a notification, tool results. One kind, because
 * readers disagree on which of them starts a turn.
 */
export interface InputEntry extends EntryBase {
  readonly kind: 'input';
  /** The content when it is plain text; undefined when it is a list of parts. */
  readonly text: string | undefined;
  /** The text parts of a listed content, in order. */
  readonly parts: readonly string[];
  /** Every tool result the line carries, in order. */
  readonly results: readonly ToolOutcome[];
  /** The host's two marks of where the input came from; they can differ, so each is kept. */
  readonly origin: InputOrigin | undefined;
  readonly turnOrigin: InputOrigin | undefined;
  /** True for the summary that resumes a compacted session. */
  readonly continuation: boolean;
  /** True when a tool's run wrote the line. */
  readonly fromTool: boolean;
  readonly background: BackgroundMark | undefined;
}

/** A tool the model called, as the host wrote it: its name and input are the host's own. */
export interface ReplyCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonRecord | undefined;
}

/**
 * One line of a model reply. A reply with several parts may be written as several lines that share a `key` and
 * repeat the usage, so a reader joins them.
 */
export interface ReplyEntry extends EntryBase {
  readonly kind: 'reply';
  /** What joins the lines of one model call; undefined for a reply nothing can join or dedupe. */
  readonly key: string | undefined;
  readonly model: string | undefined;
  /** The reasoning effort the reply ran at. */
  readonly effort: string | undefined;
  /** `unreadable` for counts that are there but damaged, never 0; undefined when the line carries none. */
  readonly usage: CallUsage | 'unreadable' | undefined;
  /** The reply's text parts, in order. */
  readonly texts: readonly string[];
  readonly calls: readonly ReplyCall[];
  /** True for a reply the host wrote in the model's place. */
  readonly synthetic: boolean;
  /** True when the model call failed; `error` names how, when the line does. */
  readonly failed: boolean;
  readonly error: string | undefined;
}

/** The host compacted the session's context here. */
export interface CompactEntry extends EntryBase {
  readonly kind: 'compact';
}

/**
 * The host's mark that nothing more is coming: written once the model stopped, or once a command that started no
 * turn ended. A turn the person stopped by hand may leave none.
 */
export interface TurnEndEntry extends EntryBase {
  readonly kind: 'turn-end';
}

/** The host's mark that the session carries on in another one, as a tab's does once it is sent to the background. */
export interface ContinuedEntry extends EntryBase {
  readonly kind: 'continued';
  /** The session it carries on in; undefined when the mark names none. */
  readonly into: string | undefined;
}

/** Text a hook added to the session. */
export interface HookNoteEntry extends EntryBase {
  readonly kind: 'hook-note';
  /** True for a note written as the session started. */
  readonly atStart: boolean;
  readonly texts: readonly string[];
}

/** A scheduled job as the host lists it. */
export interface ScheduledJob {
  readonly id: string;
  /** When it runs, as a cron expression. */
  readonly cron: string;
  readonly prompt: string;
  /** False for a job that runs once. */
  readonly recurring: boolean;
  /** When it was made, in epoch ms. */
  readonly createdAt: number;
}

/**
 * The scheduled jobs live in the host's process when it compacted the session: the session's own first, then those
 * an earlier session of the process armed. A job the host lists without its id, schedule, prompt or time is left out.
 */
export interface ScheduledCarryEntry extends EntryBase {
  readonly kind: 'scheduled-carry';
  readonly jobs: readonly ScheduledJob[];
}

/** What the host told the session of the machine and folders it runs in. */
export interface EnvironmentEntry extends EntryBase {
  readonly kind: 'environment';
  /** The folder the host gave the session for its temporary files; undefined when the note names none. */
  readonly scratchpad: string | undefined;
}

/**
 * A prompt the host put in the session's queue: one typed while a turn ran, a notification, or the prompt of a
 * scheduled job or a wake-up that came due.
 */
export interface QueuedPromptEntry extends EntryBase {
  readonly kind: 'queued-prompt';
  /** The prompt as it was queued; undefined when the line holds none. */
  readonly text: string | undefined;
}

/**
 * The host moved the session to another model on its own, as one does once its safeguards stopped a reply: the
 * session answers on `to` from here on.
 */
export interface ModelSwitchEntry extends EntryBase {
  readonly kind: 'model-switch';
  /** The model the session ran until then; undefined when the line names none. */
  readonly from: string | undefined;
  readonly to: string;
  /** Why, in the host's own word (a safeguard's category, say); undefined when the line gives none. */
  readonly reason: string | undefined;
}

/**
 * The session's title from here on: the name the person gave it, or the one the host made up from the conversation.
 * Only the person's names the session; the host's just describes it.
 */
export interface TitleEntry extends EntryBase {
  readonly kind: 'title';
  readonly by: 'person' | 'host';
  /** The title as the host wrote it, which may be blank. */
  readonly text: string;
}

/** A line of a type no reader uses yet; `type` is the host's name for it, so a check can count unknown ones. */
export interface OtherEntry extends EntryBase {
  readonly kind: 'other';
  readonly type: string | undefined;
}

export type TranscriptEntry = InputEntry | ReplyEntry | CompactEntry | TurnEndEntry | ContinuedEntry | HookNoteEntry | ScheduledCarryEntry | EnvironmentEntry | QueuedPromptEntry | ModelSwitchEntry | TitleEntry | OtherEntry;
export type EntryKind = TranscriptEntry['kind'];

/** A line that is no entry: damaged or torn text, or JSON that is not an object. It is said, never skipped. */
export interface UnreadLine {
  readonly kind: 'unread';
  readonly reason: 'damaged' | 'not-an-object';
}

export interface TranscriptReader {
  /**
   * One transcript line as its entry. With `only`, a line that cannot be one of those kinds gives undefined, most
   * of them before it is parsed: a reader of whole transcripts names the few kinds it counts. A blank line gives
   * undefined too.
   */
  entry(line: string, only?: readonly EntryKind[]): TranscriptEntry | UnreadLine | undefined;
}
