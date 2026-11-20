/**
 * The public interface's data: what `teamrig read` answers, built from what the commands already hold. Everything
 * here is pure: no disk, no clock, no `node:` module, so the same builders serve a reader that runs without Node
 * built-ins, and `interface/index.test.ts` fails if anything reachable from here imports one. The command
 * (src/cli/commands/read.ts) gathers through the ports and calls these.
 */
export { type Connector, type ConnectorItem, type ConnectorName } from './connector.ts';
export { answerOf, DOCUMENTS, isDocumentName, unchangedAnswer, type Answer, type DocumentName, type EnvelopeHead, type UnchangedAnswer } from './envelope.ts';
export { inboxBody, type InboxBody, type InboxInput, type ServedLine } from './inbox.ts';
export { refOf, type ServedRef } from './ref.ts';
export { revisionText, type RevisionParts } from './revision.ts';
export {
  sessionsBody,
  type MemberInput,
  type RetiredInput,
  type ServedAsk,
  type ServedHire,
  type ServedHost,
  type ServedLaunch,
  type ServedRetire,
  type ServedSession,
  type ServedTeam,
  type SessionPlace,
  type SessionsBody,
  type SessionsInput,
  type SessionState,
  type TabInput,
  type TeamFailure,
  type TeamInput,
} from './sessions.ts';
export { sourceOf,type ServedSource, type SourceKind, type SourceNames } from './source.ts';
export { tasksBody, type ServedAnswer, type ServedDecision, type ServedTask, type ServedWait, type TasksBody, type TasksInput } from './tasks.ts';
export { cutText, ServedText, type Cut, type MarkedText, type SecretShapes, type TextSource } from './text.ts';
export { checkInterfaceRange, INTERFACE_MAJOR, INTERFACE_MINOR, INTERFACE_VERSION, parseInterfaceVersion, type InterfaceVersion, type RangeCheck } from './version.ts';
