/**
 * The plugin API: everything an adapter may import from teamrig. An adapter imports this file and its own folder,
 * nothing else, so moving one out of the repo changes no line of it but this import.
 */
export { API_VERSION, apiVersionNotice, isApiVersion } from './version.ts';
export { OSES, isManifest, isOs, isProofRef, isSupport, manifestProblems, provedOn, supportProblem, type Manifest, type Os, type ProofRef, type Support } from './support.ts';
export { ADAPTER_ID, adapterEntry, declarationProblems, type AdapterDeclaration, type AdapterEntry } from './declaration.ts';
export { defineHost, hostAdapterProblems, hostDeclarationProblems, isHostAdapter, isHostDeclaration, type HostAdapter, type HostDeclaration, type HostDeps } from './host.ts';
export {
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
  CONNECTOR_FEATURES,
  CONNECTOR_KINDS,
  HOST_FEATURES,
  featuresOf,
  isConnectorFeatureId,
  isConnectorKind,
  isHostFeatureId,
  type ConnectorFeatureId,
  type ConnectorKind,
  type FeatureId,
  type FeatureIdOf,
  type FeatureRow,
  type FeatureSide,
  type HostFeatureId,
  type Toggle,
} from '../features/registry.ts';
export type { CredentialRead, CredentialStore } from '../core/credentials.ts';
export type { Env } from '../core/home.ts';
export type { ProgramRequest, ProgramResult, ProgramRunner } from '../core/program-runner.ts';
export type { SecretScanner } from '../core/secrets.ts';
export type { ShellEnd } from '../core/shell-end.ts';
