/**
 * The host ports: what the core asks of the AI CLI it runs in, one small port per concern. A host adapter builds
 * every one of them, and gives an {@link Unsupported} with its reason for a port its tool cannot fill, so a missing
 * port is a refusal the core words, never a crash.
 */
import type { HookBridge } from './hook-bridge.ts';
import type { StatusLine } from './status-line.ts';
import type { ToolCallShape } from './tool-call.ts';
import type { TranscriptReader } from './transcript-reader.ts';
import type { Unsupported } from './unsupported.ts';
import type { UsageMeter } from './usage-meter.ts';

export { HOOK_EVENTS, isHookEventName, type HookBridge, type HookEvent, type HookEventName, type HookHelper, type HookReply, type HookVerdict } from './hook-bridge.ts';
export {
  SHELL_DIALECTS,
  TOOL_KINDS,
  isToolKind,
  type EditCall,
  type HelperCall,
  type MessageCall,
  type PlainCall,
  type ReadCall,
  type SearchCall,
  type ShellCall,
  type ShellDialect,
  type SkillCall,
  type ToolCall,
  type ToolCallShape,
  type ToolKind,
  type WebCall,
} from './tool-call.ts';
export { isUnsupported, unsupported, type Unsupported } from './unsupported.ts';
export type { StatusLine, StatusLineAnswer, StatusLinePlan, StatusReading } from './status-line.ts';
export type { RateLimits, RateWindow, TokenWeights, UsageMeter } from './usage-meter.ts';

/** Every host port by its name. Each line is required: an adapter names every port, filled or not. */
export interface HostPorts {
  readonly hooks: HookBridge | Unsupported;
  readonly toolCall: ToolCallShape | Unsupported;
  readonly transcripts: TranscriptReader | Unsupported;
  readonly usage: UsageMeter | Unsupported;
  readonly statusLine: StatusLine | Unsupported;
}

/** The name of every host port, held to {@link HostPorts} by its type: a port added there is a line missing here. */
const NAMED = { hooks: true, toolCall: true, transcripts: true, usage: true, statusLine: true } as const satisfies Readonly<Record<keyof HostPorts, true>>;

export const HOST_PORT_NAMES: readonly string[] = Object.keys(NAMED);

export {
  INPUT_ORIGINS,
  type BackgroundMark,
  type CallUsage,
  type CompactEntry,
  type ContinuedEntry,
  type EntryKind,
  type EntryThread,
  type EnvironmentEntry,
  type HookNoteEntry,
  type InputEntry,
  type InputOrigin,
  type ModelSwitchEntry,
  type OtherEntry,
  type QueuedPromptEntry,
  type ReplyCall,
  type ReplyEntry,
  type ScheduledCarryEntry,
  type ScheduledJob,
  type TitleEntry,
  type ToolOutcome,
  type TranscriptEntry,
  type TranscriptReader,
  type TurnEndEntry,
  type UnreadLine,
} from './transcript-reader.ts';
