/**
 * The host ports: what the core asks of the AI CLI it runs in, one small port per concern. A host adapter builds
 * every one of them, and gives an {@link Unsupported} with its reason for a port its tool cannot fill, so a missing
 * port is a refusal the core words, never a crash.
 */
import type { StatusLine } from './status-line.ts';
import type { TranscriptReader } from './transcript-reader.ts';
import type { Unsupported } from './unsupported.ts';
import type { UsageMeter } from './usage-meter.ts';

export { isUnsupported, unsupported, type Unsupported } from './unsupported.ts';
export type { StatusLine, StatusLineAnswer, StatusLinePlan, StatusReading } from './status-line.ts';
export type { RateLimits, RateWindow, TokenWeights, UsageMeter } from './usage-meter.ts';

/** Every host port by its name. Each line is required: an adapter names every port, filled or not. */
export interface HostPorts {
  readonly transcripts: TranscriptReader | Unsupported;
  readonly usage: UsageMeter | Unsupported;
  readonly statusLine: StatusLine | Unsupported;
}

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
