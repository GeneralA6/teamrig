import type { CredentialStore } from '../core/credentials.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import type { HttpClient } from '../core/http.ts';
import type { ProgramRunner } from '../core/program-runner.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { featuresOf, isConnectorKind, type ConnectorKind } from '../features/registry.ts';
import type { CodeHost, Tracker } from '../issues/host.ts';
import { adapterEntry, declarationProblems, type AdapterDeclaration } from './declaration.ts';
import { isSupport } from './support.ts';

/** What the adapter of an outside tool says of itself. */
export interface ConnectorDeclaration extends AdapterDeclaration<'connector'> {
  /** What the tool is to a team. A feature of a kind not listed here is unsupported in the manifest. */
  readonly kinds: readonly ConnectorKind[];
  /** What a task's ref to one of the tool's items starts with (`gh:`). */
  readonly refPrefix: string;
}

/** What the loader hands a connector adapter to build its ports from: nothing else of teamrig reaches it. */
export interface ConnectorDeps {
  readonly run: ProgramRunner;
  /** The tool's API, for a connector whose tool has no command line to run: https only, no redirect followed. */
  readonly http: HttpClient;
  readonly credentials: CredentialStore;
  readonly env: Env;
  readonly scanner: SecretScanner;
  /** Whether text the connector posts ends with the made-with-teamrig footer. */
  readonly stamp: boolean;
}

/** The ports a connector builds, one per kind it declares: a tool that is both kinds, as GitHub is, builds both. */
export interface ConnectorPorts {
  readonly tracker?: Tracker;
  readonly codeHost?: CodeHost;
}

/** The adapter of one outside tool: its declaration, and the ports it builds once the loader has accepted it. */
export interface ConnectorAdapter<Ports extends ConnectorPorts = ConnectorPorts> {
  readonly declaration: ConnectorDeclaration;
  readonly create: (deps: ConnectorDeps) => Ports;
}

/** The default export of a connector adapter's entry. */
export function defineConnector<Ports extends ConnectorPorts>(adapter: ConnectorAdapter<Ports>): ConnectorAdapter<Ports> {
  return adapter;
}

const REF_PREFIX = /^[a-z][a-z0-9-]*:$/;

function kindsOf(declaration: JsonRecord): readonly ConnectorKind[] | undefined {
  const kinds: unknown = declaration['kinds'];
  if (!Array.isArray(kinds) || kinds.length === 0 || new Set(kinds).size !== kinds.length) {
    return undefined;
  }
  return kinds.every(isConnectorKind) ? kinds : undefined;
}

/** The rows that claim a feature of a kind the connector does not declare. */
function strayKindProblems(kinds: readonly ConnectorKind[], manifest: unknown): readonly string[] {
  if (!isRecord(manifest)) {
    return [];
  }
  return featuresOf('connector').flatMap((row) => {
    const support = manifest[row.id];
    const stray = !kinds.some((kind) => kind === row.group) && isSupport(support) && support.kind !== 'unsupported';
    return stray ? [`${row.id} is not unsupported, but its kinds do not list ${row.group}`] : [];
  });
}

export function connectorDeclarationProblems(value: unknown): readonly string[] {
  const shared = declarationProblems('connector', value);
  if (!isRecord(value)) {
    return shared;
  }
  const kinds = kindsOf(value);
  const refPrefix = stringField(value, 'refPrefix');
  return [
    ...shared,
    ...(kinds === undefined ? ['its kinds must list tracker, codehost or both, each once'] : strayKindProblems(kinds, value['manifest'])),
    ...(refPrefix !== undefined && REF_PREFIX.test(refPrefix) ? [] : ['its refPrefix must be a lower-case word ending in a colon']),
  ];
}

export function isConnectorDeclaration(value: unknown): value is ConnectorDeclaration {
  return connectorDeclarationProblems(value).length === 0;
}

/** What stops `value` from being a connector adapter's entry; empty when it is one. */
export function connectorAdapterProblems(value: unknown): readonly string[] {
  const entry = adapterEntry(value);
  return entry === undefined ? ['its entry is not made by defineConnector: it needs a declaration and a create function'] : connectorDeclarationProblems(entry.declaration);
}

export function isConnectorAdapter(value: unknown): value is ConnectorAdapter {
  return connectorAdapterProblems(value).length === 0;
}
