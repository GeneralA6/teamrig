/**
 * The host ports: what the core asks of the AI CLI it runs in, one small port per concern. A host adapter builds
 * every one of them, and gives an {@link Unsupported} with its reason for a port its tool cannot fill, so a missing
 * port is a refusal the core words, never a crash.
 */
import type { TranscriptReader } from './transcript-reader.ts';
import type { Unsupported } from './unsupported.ts';

export { isUnsupported, unsupported, type Unsupported } from './unsupported.ts';

/** Every host port by its name. Each line is required: an adapter names every port, filled or not. */
export interface HostPorts {
  readonly transcripts: TranscriptReader | Unsupported;
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
  type OtherEntry,
  type QueuedPromptEntry,
  type ReplyCall,
  type ReplyEntry,
  type ScheduledCarryEntry,
  type ScheduledJob,
  type ToolOutcome,
  type TranscriptEntry,
  type TranscriptReader,
  type TurnEndEntry,
  type UnreadLine,
} from './transcript-reader.ts';
