/**
 * The plugin API: everything an adapter may import from teamrig. An adapter imports this file and its own folder,
 * nothing else, so moving one out of the repo changes no line of it but this import.
 */
export { API_VERSION, apiVersionNotice, isApiVersion } from "./version.js";
export { OSES, isManifest, isOs, isProofRef, isSupport, manifestProblems, provedOn, supportProblem } from "./support.js";
export { ADAPTER_ID, adapterEntry, declarationProblems } from "./declaration.js";
export { defineHost, hostAdapterProblems, hostDeclarationProblems, isHostAdapter, isHostDeclaration } from "./host.js";
export { connectorAdapterProblems, connectorDeclarationProblems, defineConnector, isConnectorAdapter, isConnectorDeclaration, } from "./connector.js";
export { PANE_STATES, TERMINAL_REQUESTS, isPaneState, isTerminalRequest, } from "./terminal.js";
export { defineTerminal, isTerminalAdapter, isTerminalDeclaration, terminalAdapterProblems, terminalDeclarationProblems, } from "./terminal-adapter.js";
export { CONNECTOR_FEATURES, CONNECTOR_KINDS, HOST_FEATURES, TERMINAL_FEATURES, featuresOf, isConnectorFeatureId, isConnectorKind, isHostFeatureId, isTerminalFeatureId, } from "../features/registry.js";
export { INPUT_ORIGINS, isUnsupported, unsupported, } from "../ports/host/index.js";
// What an adapter reads outside JSON with, an API's answer or a host's own line: it is narrowed, never cast.
export { instantField, isNonNegativeInteger, isRecord, isStringArray, recordField, stringField } from "../core/guards.js";
// The footer of a text a connector posts: taken off a text already stamped, and its parts for a tool with no Markdown.
export { stampCredit, withoutStampFooter } from "../core/stamp.js";
// Whether a comment's text is a claim line: a tracker matches it as it reads the comment, and drops the text.
export { isClaim } from "../issues/claim.js";
