/**
 * The conformance kit: the cases every adapter of a port must pass, held as values so the same case runs an adapter
 * inside teamrig and an outside program reached through the protocol. It imports the plugin API, `node:assert` and
 * its own folder, nothing else, so it ships as it is to whoever builds a host or a connector.
 */
import { TRANSCRIPT_CONTRACT } from './host/transcript.ts';
import { USAGE_CONTRACT } from './host/usage.ts';
import { entryOf, type KitEntry } from './kit.ts';
import { TERMINAL_CONTRACT } from './terminal/terminal.ts';

export { bind, defineContract, osOf, runCases, type Binding, type BoundCase, type BoundContract, type CaseOutcome, type CaseResult, type Contract, type ContractCase, type Subject } from './contract.ts';
export { choiceOf, type Choice, type ChoiceRequest, type Chosen, type ContractOutline } from './choice.ts';
export { entryOf, kitProblems, type KitEntry } from './kit.ts';
export { TERMINAL_CONTRACT, type ShownPane, type TerminalCase, type TerminalSubject, type TerminalWorld } from './terminal/terminal.ts';
export { nothingTerminal, referenceTerminal, yesTerminal, type ReferenceOptions } from './terminal/reference.ts';
export { nothingTranscripts, TRANSCRIPT_CONTRACT, yesTranscripts, type TranscriptCase, type TranscriptSubject, type TranscriptWorld, type WorldReply } from './host/transcript.ts';
export { nothingUsage, USAGE_CONTRACT, yesUsage, type UsageCase, type UsageSubject, type UsageWorld, type WorldLimits } from './host/usage.ts';

/**
 * Every contract of the kit. A port's contract lives in its own file, under `host/`, `connector/` or `terminal/`,
 * and is listed here with one `entryOf(...)` line at the end, so two changes adding contracts never touch the same
 * lines.
 */
export const CONTRACTS: readonly KitEntry[] = [
  entryOf(TERMINAL_CONTRACT),
  entryOf(TRANSCRIPT_CONTRACT),
  entryOf(USAGE_CONTRACT),
];
