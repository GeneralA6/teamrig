import type { JsonRecord } from '../../core/guards.ts';
import type { ToolCall } from './tool-call.ts';

/**
 * The moments of a session a host may call teamrig at, under teamrig's own names. A host maps each of its hook
 * events to one of them, and one it has no name for reaches the core as `other`.
 */
export const HOOK_EVENTS = [
  'session-start',
  'session-end',
  'prompt',
  'tool-start',
  'permission-prompt',
  'tool-end',
  'tool-failed',
  'stop',
  'stop-failed',
  'helper-start',
  'helper-stop',
  'compact-start',
  'compact-end',
  'form-start',
  'form-end',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export function isHookEventName(value: unknown): value is HookEventName {
  return HOOK_EVENTS.some((name) => name === value);
}

/** The helper agent a hook event came from. */
export interface HookHelper {
  readonly id: string | undefined;
  readonly type: string | undefined;
  readonly transcript: string | undefined;
}

/**
 * One hook call as the core reads it. Every field is always there, undefined when the host sent none, and the
 * host's own payload is not: a reader that needs more asks the port for a field, so no host's key names reach the
 * core.
 */
export interface HookEvent {
  readonly name: HookEventName | 'other';
  /** The event as the host names it: for the logs and for `other`. */
  readonly hostName: string | undefined;
  /** The host's session id, undefined when it is absent or not shaped as one. */
  readonly session: string | undefined;
  readonly cwd: string | undefined;
  /** The path of the session's transcript. */
  readonly transcript: string | undefined;
  /** The title the human gave the session in the host's own lists; undefined when the host sent none or a blank one. */
  readonly title: string | undefined;
  /** Set when a helper agent, not the session itself, made the call. */
  readonly helper: HookHelper | undefined;
  /** The tool call the event is about. */
  readonly call: ToolCall | undefined;
  /** What the human typed, on `prompt`. */
  readonly prompt: string | undefined;
  /** The model's last reply, on a stop. */
  readonly lastReply: string | undefined;
  /** Whether this stop follows one a hook already blocked: a second block could loop for ever. */
  readonly stopActive: boolean;
  /** Why the session started: new, resumed, cleared or compacted, in the host's word. */
  readonly source: string | undefined;
  /** Why the session ended, in the host's word, on `session-end`. */
  readonly reason: string | undefined;
  /** What started a compaction, in the host's word. */
  readonly trigger: string | undefined;
  readonly model: string | undefined;
  /** How hard the model is set to think, in the host's word. */
  readonly effort: string | undefined;
  /** The text of a form or a notice the event shows the human. */
  readonly message: string | undefined;
  /** What failed, on `stop-failed` and `tool-failed`. */
  readonly error: string | undefined;
}

/** What a hook rules on the moment it was called at. */
export type HookVerdict =
  | { readonly kind: 'allow'; readonly reason?: string | undefined }
  | { readonly kind: 'deny'; readonly reason: string }
  /** `hidePrompt` asks the host to keep a refused prompt out of the transcript. */
  | { readonly kind: 'block'; readonly reason: string; readonly hidePrompt?: boolean | undefined };

/**
 * What a hook answers, in the core's terms: each part is optional, and a host drops the parts it has no place
 * for on the event at hand.
 */
export interface HookReply {
  readonly verdict?: HookVerdict | undefined;
  /** Text for the model. */
  readonly context?: string | undefined;
  /** Text for the human. */
  readonly notice?: string | undefined;
  /** The terminal tab's title. */
  readonly tabTitle?: string | undefined;
  /** The session's title in the host's own lists. */
  readonly sessionTitle?: string | undefined;
  /** What the model sees in place of the tool's own answer. */
  readonly toolOutput?: JsonRecord | undefined;
}

/** The port that turns a host's hook call into a {@link HookEvent} and a {@link HookReply} into what the host reads. */
export interface HookBridge {
  /** The event a hook's input holds; undefined when it is not the host's hook input at all. */
  parse(raw: string): HookEvent | undefined;
  /** The text to write on standard output for `reply` to the event `on`; empty when there is nothing to write. */
  reply(on: HookEventName, reply: HookReply): string;
  /** What the host does when a hook itself fails: `blocks` stops the moment, `passes` lets it go on. */
  readonly failureRule: 'blocks' | 'passes';
}
