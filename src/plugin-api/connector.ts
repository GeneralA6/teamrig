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
  /**
   * The keys of the connector's section of the team config (`connectors.<id>`), each in camelCase beside one line on
   * what it holds; empty for a connector that reads none. A key of the section not listed here is reported.
   */
  readonly configKeys: Readonly<Record<string, string>>;
}

/**
 * How long one run of a connector's tool may take before the runner it is handed stops it: a page of a hundred
 * issues takes seconds. A connector reads it to say, in a failure line, how long its tool got.
 */
export const CONNECTOR_RUN_TIMEOUT_MS = 60_000;

/**
 * The bytes one run of a connector's tool may print, stdout and stderr together, before that runner stops it and
 * rejects with ProgramOutputCapError. The largest answer teamrig asks for is a page of a hundred issues, each body
 * at most 65,536 characters (about 20 MB in the worst UTF-8); the cap sits above it, so text people post can never
 * grow one run's memory without bound.
 */
export const CONNECTOR_RUN_MAX_BYTES = 32 * 1024 * 1024;

/** Takes one problem of a connector's config section: the key's path inside the section, and what is wrong with it. */
export type ConfigReport = (key: string, problem: string) => void;

/** What the loader hands a connector adapter to build its ports from: nothing else of teamrig reaches it. */
export interface ConnectorDeps {
  /** Runs the connector's tool, each run held to CONNECTOR_RUN_TIMEOUT_MS and CONNECTOR_RUN_MAX_BYTES. */
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

/** What the author of a connector writes: its declaration, how its config section is read, and how its ports are built. */
export interface ConnectorSpec<Ports extends ConnectorPorts, Config> {
  readonly declaration: ConnectorDeclaration;
  /**
   * Reads the connector's section of the team config, as the JSON holds it. Total: a wrong key is reported and reads
   * as its default, so a check of the config lists every problem at once and builds nothing.
   */
  readonly parseConfig: (section: JsonRecord, report: ConfigReport) => Config;
  readonly create: (deps: ConnectorDeps, config: Config) => Ports;
}

/**
 * The adapter of one outside tool, as the loader holds it: its declaration, and `configure`, which reads the tool's
 * config section and gives what builds its ports. The type its config reads as stays inside, so the loader holds
 * adapters of every config alike; a check of the config calls `configure` alone.
 */
export interface ConnectorAdapter<Ports extends ConnectorPorts = ConnectorPorts> {
  readonly declaration: ConnectorDeclaration;
  readonly configure: (section: JsonRecord, report: ConfigReport) => (deps: ConnectorDeps) => Ports;
}

/** What a section key the declaration does not list is reported as. */
function strayKeyProblem(declaration: ConnectorDeclaration): string {
  const known = Object.keys(declaration.configKeys);
  return `is no key of the ${declaration.name} connector; it takes ${known.length === 0 ? 'none' : known.join(', ')}`;
}

/** The default export of a connector adapter's entry. */
export function defineConnector<Ports extends ConnectorPorts, Config>(spec: ConnectorSpec<Ports, Config>): ConnectorAdapter<Ports> {
  const { declaration } = spec;
  return {
    declaration,
    configure: (section, report) => {
      for (const key of Object.keys(section)) {
        if (!Object.hasOwn(declaration.configKeys, key)) {
          report(key, strayKeyProblem(declaration));
        }
      }
      const config = spec.parseConfig(section, report);
      return (deps) => spec.create(deps, config);
    },
  };
}

const REF_PREFIX = /^[a-z][a-z0-9-]*:$/;
const CONFIG_KEY = /^[a-z][a-zA-Z0-9]*$/;

function isConfigKeys(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([key, holds]) => CONFIG_KEY.test(key) && typeof holds === 'string' && holds.trim() !== '' && !holds.includes('\n'));
}

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
    ...(isConfigKeys(value['configKeys']) ? [] : ['its configKeys must name each config key in camelCase beside one line on what it holds']),
  ];
}

export function isConnectorDeclaration(value: unknown): value is ConnectorDeclaration {
  return connectorDeclarationProblems(value).length === 0;
}

/** What stops `value` from being a connector adapter's entry; empty when it is one. */
export function connectorAdapterProblems(value: unknown): readonly string[] {
  const entry = adapterEntry(value, 'configure');
  return entry === undefined ? ['its entry is not made by defineConnector: it needs a declaration and a configure function'] : connectorDeclarationProblems(entry.declaration);
}

export function isConnectorAdapter(value: unknown): value is ConnectorAdapter {
  return connectorAdapterProblems(value).length === 0;
}
