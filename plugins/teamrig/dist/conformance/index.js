/**
 * The conformance kit: the cases every adapter of a port must pass, held as values so the same case runs an adapter
 * inside teamrig and an outside program reached through the protocol. It imports the plugin API, `node:assert` and
 * its own folder, nothing else, so it ships as it is to whoever builds a host or a connector.
 */
import { PERMISSIONS_CONTRACT } from "./host/permissions.js";
import { STATUS_LINE_CONTRACT } from "./host/status-line.js";
import { TRANSCRIPT_CONTRACT } from "./host/transcript.js";
import { USAGE_CONTRACT } from "./host/usage.js";
import { entryOf } from "./kit.js";
import { TERMINAL_CONTRACT } from "./terminal/terminal.js";
export { bind, defineContract, osOf, runCases } from "./contract.js";
export { choiceOf } from "./choice.js";
export { entryOf, kitProblems } from "./kit.js";
export { TERMINAL_CONTRACT } from "./terminal/terminal.js";
export { nothingTerminal, referenceTerminal, yesTerminal } from "./terminal/reference.js";
export { nothingTranscripts, TRANSCRIPT_CONTRACT, yesTranscripts } from "./host/transcript.js";
export { nothingUsage, USAGE_CONTRACT, yesUsage } from "./host/usage.js";
export { nothingStatusLine, STATUS_LINE_CONTRACT, yesStatusLine } from "./host/status-line.js";
export { nothingPermissions, PERMISSIONS_CONTRACT, yesPermissions } from "./host/permissions.js";
/**
 * Every contract of the kit. A port's contract lives in its own file, under `host/`, `connector/` or `terminal/`,
 * and is listed here with one `entryOf(...)` line at the end, so two changes adding contracts never touch the same
 * lines.
 */
export const CONTRACTS = [
    entryOf(TERMINAL_CONTRACT),
    entryOf(TRANSCRIPT_CONTRACT),
    entryOf(USAGE_CONTRACT),
    entryOf(STATUS_LINE_CONTRACT),
    entryOf(PERMISSIONS_CONTRACT),
];
