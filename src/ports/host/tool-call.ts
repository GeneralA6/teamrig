import type { JsonRecord } from '../../core/guards.ts';

/**
 * What a tool call is for, whatever the host names the tool: the core's guards and reminders ask for a kind and its
 * fields, never for a tool's name or the keys of its input. `task-input` is a host's own task list; `other` is every
 * tool the core has no rule for.
 */
export const TOOL_KINDS = ['shell', 'read', 'edit', 'search', 'web', 'helper', 'skill', 'ask', 'schedule', 'message', 'task-input', 'other'] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

/** The shell languages a shell call's command is written in: a guard parses each by its own rules. */
export const SHELL_DIALECTS = ['bash', 'powershell'] as const;

export type ShellDialect = (typeof SHELL_DIALECTS)[number];

/** What every tool call carries, of whatever kind. */
interface ToolCallBase {
  /** The tool as the host names it: for a refusal's text and the logs, never for a decision. */
  readonly name: string;
  /** The call's input as the host sent it, for the few readers of a field no kind names. */
  readonly input: JsonRecord;
  /** The host's id of this one call, where it gives one. */
  readonly id?: string | undefined;
  /** What the tool answered, on the events that come after it ran. */
  readonly response?: unknown;
  /**
   * The answer as the record a hook may put a changed copy of in its place (`HookReply.toolOutput`), which must keep
   * the answer's shape; unset where the host is not known to take a replacement for this call's answer.
   */
  readonly replaceable?: JsonRecord | undefined;
}

/** A command line handed to a shell. */
export interface ShellCall extends ToolCallBase {
  readonly kind: 'shell';
  readonly dialect: ShellDialect;
  /** The command as written; undefined when the call carries none. */
  readonly command: string | undefined;
  /**
   * Every text the shell may run for this call: the command as written and, where the host rewrites it on its way
   * to the shell, each rewritten text. A guard weighs each reading and takes the stricter verdict.
   */
  readonly readings: readonly string[];
}

/** One file read. */
export interface ReadCall extends ToolCallBase {
  readonly kind: 'read';
  readonly path: string | undefined;
}

/** One text put in place of another in a file's text. */
export interface TextReplacement {
  readonly from: string;
  readonly to: string;
  /** Every place the text stands, not only the first. */
  readonly all: boolean;
}

/** What an edit does to its file's text: the whole text it leaves, or the replacements it makes, in order. */
export type TextChange =
  | { readonly kind: 'whole'; readonly text: string }
  | { readonly kind: 'replacements'; readonly replacements: readonly TextReplacement[] };

/** One file written or changed. */
export interface EditCall extends ToolCallBase {
  readonly kind: 'edit';
  readonly path: string | undefined;
  /** Every text the call writes into the file, in the input's order. */
  readonly texts: readonly string[];
  /**
   * The call as a change of the file's text; undefined when its input does not read as one (a field missing, an edit
   * of something other than the text), so a reader cannot tell the text the call leaves.
   */
  readonly change: TextChange | undefined;
}

/** A search of file names or of file contents. */
export interface SearchCall extends ToolCallBase {
  readonly kind: 'search';
  readonly path: string | undefined;
  readonly glob: string | undefined;
  /** Whether the answer shows lines of the files it matched, not only their names. */
  readonly showsContent: boolean;
}

/** A page fetched or a web search. */
export interface WebCall extends ToolCallBase {
  readonly kind: 'web';
  readonly url: string | undefined;
}

/** A helper agent started. */
export interface HelperCall extends ToolCallBase {
  readonly kind: 'helper';
  readonly type: string | undefined;
}

/** A skill loaded. */
export interface SkillCall extends ToolCallBase {
  readonly kind: 'skill';
  readonly skill: string | undefined;
}

/** A message to another agent. */
export interface MessageCall extends ToolCallBase {
  readonly kind: 'message';
  /** The receiver's name, less any mark the host adds to tell two agents of one name apart; undefined when the call names none. */
  readonly to: string | undefined;
  /** The text sent; undefined for a call that sends none. */
  readonly text: string | undefined;
}

/** A call of a kind that carries no field of its own. */
export interface PlainCall extends ToolCallBase {
  readonly kind: 'ask' | 'schedule' | 'task-input' | 'other';
}

export type ToolCall = ShellCall | ReadCall | EditCall | SearchCall | WebCall | HelperCall | SkillCall | MessageCall | PlainCall;

/** The port that reads a host's tool call into a {@link ToolCall}. */
export interface ToolCallShape {
  /** The call of the tool the host names `name`, with the input it sent; a tool the host does not know is `other`. */
  normalize(name: string, input: JsonRecord): ToolCall;
}

export function isToolKind(value: unknown): value is ToolKind {
  return TOOL_KINDS.some((kind) => kind === value);
}
