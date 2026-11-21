/**
 * The plugin API: everything an adapter may import from teamrig. An adapter imports this file and its own folder,
 * nothing else, so moving one out of the repo changes no line of it but this import.
 */
export { API_VERSION, apiVersionNotice, isApiVersion } from './version.ts';
export { OSES, isManifest, isOs, isProofRef, isSupport, manifestProblems, provedOn, supportProblem, type Manifest, type Os, type ProofRef, type Support } from './support.ts';
export { ADAPTER_ID, adapterEntry, declarationProblems, type AdapterDeclaration, type AdapterEntry } from './declaration.ts';
export { defineHost, hostAdapterProblems, hostDeclarationProblems, isHostAdapter, isHostDeclaration, type HostAdapter, type HostDeclaration, type HostDeps } from './host.ts';
export {
  CONNECTOR_RUN_MAX_BYTES,
  CONNECTOR_RUN_TIMEOUT_MS,
  connectorAdapterProblems,
  connectorDeclarationProblems,
  defineConnector,
  isConnectorAdapter,
  isConnectorDeclaration,
  type ConnectorAdapter,
  type ConnectorDeclaration,
  type ConnectorDeps,
  type ConnectorPorts,
} from './connector.ts';
export {
  PANE_STATES,
  TERMINAL_REQUESTS,
  isPaneState,
  isTerminalRequest,
  type DeliverAnswer,
  type HeldWhy,
  type IdleAnswer,
  type ListAnswer,
  type ListedPane,
  type OpenAnswer,
  type PaneAnswer,
  type PaneIdentity,
  type PaneOpen,
  type PaneState,
  type TerminalCapabilities,
  type TerminalFailure,
  type TerminalPort,
  type TerminalRequest,
  type Unserved,
  type Wake,
} from './terminal.ts';
export {
  defineTerminal,
  isTerminalAdapter,
  isTerminalDeclaration,
  terminalAdapterProblems,
  terminalDeclarationProblems,
  type TerminalAdapter,
  type TerminalDeclaration,
  type TerminalDeps,
  type TerminalPorts,
} from './terminal-adapter.ts';
export {
  CONNECTOR_FEATURES,
  CONNECTOR_KINDS,
  HOST_FEATURES,
  TERMINAL_FEATURES,
  featuresOf,
  isConnectorFeatureId,
  isConnectorKind,
  isHostFeatureId,
  isTerminalFeatureId,
  type ConnectorFeatureId,
  type ConnectorKind,
  type FeatureId,
  type FeatureIdOf,
  type FeatureRow,
  type FeatureSide,
  type HostFeatureId,
  type TerminalFeatureId,
  type Toggle,
} from '../features/registry.ts';
export {
  HOOK_EVENTS,
  INPUT_ORIGINS,
  SHELL_DIALECTS,
  TOOL_KINDS,
  isHookEventName,
  isToolKind,
  isUnsupported,
  unsupported,
  type AskCall,
  type BackgroundMark,
  type CallUsage,
  type CompactEntry,
  type ContinuedEntry,
  type EditCall,
  type EntryKind,
  type EntryThread,
  type EnvironmentEntry,
  type FolderSettings,
  type HelperCall,
  type HookBridge,
  type HookEvent,
  type HookEventName,
  type HookHelper,
  type HookNoteEntry,
  type HookReply,
  type HookVerdict,
  type HostPaths,
  type HostPermissions,
  type HostPlugin,
  type HostPorts,
  type InputEntry,
  type InputOrigin,
  type InstallReach,
  type MarketplaceSource,
  type MessageCall,
  type ModelSwitchEntry,
  type OtherEntry,
  type PermissionsAnswer,
  type PermissionsReading,
  type PlainCall,
  type PluginInstall,
  type QueuedPromptEntry,
  type ReadCall,
  type ReplyCall,
  type ReplyEntry,
  type ScheduledCarryEntry,
  type ScheduledJob,
  type SearchCall,
  type SessionIdentity,
  type SessionLauncher,
  type SessionVariables,
  type ShellCall,
  type ShellDialect,
  type SkillCall,
  type StatusLine,
  type StatusLineAnswer,
  type StatusLinePlan,
  type StatusReading,
  type TextChange,
  type TextReplacement,
  type TitleEntry,
  type RateLimits,
  type RateWindow,
  type TokenWeights,
  type ToolCall,
  type ToolCallShape,
  type ToolKind,
  type ToolOutcome,
  type TranscriptEntry,
  type TranscriptReader,
  type TrustedRoutesPlan,
  type TurnEndEntry,
  type UnreadLine,
  type Unsupported,
  type UsageMeter,
  type WebCall,
} from '../ports/host/index.ts';
export type { CredentialRead, CredentialStore } from '../core/credentials.ts';
// What an adapter reads outside JSON with, an API's answer or a host's own line: it is narrowed, never cast. And a
// thrown value's code and text.
export {
  errorCode,
  errorMessage,
  instantField,
  isNonNegativeInteger,
  isRecord,
  isStringArray,
  numberField,
  recordField,
  stringField,
  type JsonRecord,
} from '../core/guards.ts';
export type { Env } from '../core/home.ts';
export type { HttpClient, HttpMethod, HttpRequest, HttpResult } from '../core/http.ts';
// Outside text as one printable line: what a connector puts of a tool's answer into a line a person reads.
export { plainLine } from '../core/printable.ts';
// The footer of a text a connector posts: put on, taken off a text already stamped, and its parts for a tool with no Markdown.
export { stampCredit, withStampFooter, withoutStampFooter, type StampCredit } from '../core/stamp.ts';
// Whether a comment's text is a claim line: a tracker matches it as it reads the comment, and drops the text.
export { isClaim } from '../issues/claim.ts';
// A tracker as the public interface's documents name it, and the issue a task's ref names: a tracker's adapter builds
// the first from the second.
export type { Connector, ConnectorItem, ConnectorName } from '../interface/connector.ts';
export { parseRef } from '../issues/ref.ts';
export type { FieldKind, FieldValue, FieldedIssue, HostField, HostFieldRead, IssueFields } from '../issues/fields.ts';
export {
  issuePage,
  targetText,
  type CloseReason,
  type CodeHost,
  type HostAssignee,
  type HostComments,
  type HostEnd,
  type HostIssueId,
  type HostIssueLabels,
  type HostJobLog,
  type HostLabel,
  type HostLabelFile,
  type HostLinks,
  type HostList,
  type HostOpen,
  type HostPulls,
  type HostReach,
  type HostThread,
  type HostUse,
  type HostViewer,
  type HostWatch,
  type IssueDraft,
  type IssueHost,
  type IssueTarget,
  type LabelSpec,
  type Tracker,
  type WatchMarks,
} from '../issues/host.ts';
export type { HostIssue, IssueComment, IssueState, IssueThread, LabelEvent, LinkedIssue, ReadComment } from '../issues/issue.ts';
// A repository's label file, and the labels teamrig keeps: the only labels a tracker may make.
export { LABEL_FILE, parseLabelFile } from '../issues/label-file.ts';
export { areaLabelSpec, MANAGED_LABEL_SPECS } from '../issues/managed-labels.ts';
// The shape of an account name, checked before one is put into a request.
export { isLogin } from '../issues/login.ts';
export type { HostPost, HostPosts } from '../issues/post.ts';
export type { FailedJob, HostPull, PullChecks, PullMergeable, PullReview, PullState } from '../issues/pull.ts';
// How far a scan of mentions and reviews reads: a connector pages by them, and the scan's caller counts by them.
export { MENTION_PAGE_SIZE, MENTION_PAGES_MAX, REVIEW_READS_MAX } from '../issues/scan-caps.ts';
// The name an owner's key is saved under.
export { tokenName } from '../issues/token-names.ts';
// The length a posted comment is held to, and why a label may not be written.
export { labelRefusal, MAX_COMMENT } from '../issues/write.ts';
// How a program ended, as a failure line words it.
export { exitText } from '../open/processes.ts';
export { ProgramOutputCapError, type ProgramRequest, type ProgramResult, type ProgramRunner } from '../core/program-runner.ts';
export type { SecretScanner } from '../core/secrets.ts';
export type { ShellEnd } from '../core/shell-end.ts';
