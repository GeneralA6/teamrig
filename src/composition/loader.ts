import { errorMessage, isRecord } from '../core/guards.ts';
import {
  API_VERSION,
  apiVersionNotice,
  connectorAdapterProblems,
  connectorDeclarationProblems,
  hostAdapterProblems,
  hostDeclarationProblems,
  isConnectorAdapter,
  isConnectorDeclaration,
  isHostAdapter,
  isHostDeclaration,
  isTerminalAdapter,
  isTerminalDeclaration,
  terminalAdapterProblems,
  terminalDeclarationProblems,
  type ConnectorAdapter,
  type ConnectorDeclaration,
  type FeatureSide,
  type HostAdapter,
  type HostDeclaration,
  type TerminalAdapter,
  type TerminalDeclaration,
} from '../plugin-api/index.ts';
import { CONNECTOR_ADAPTERS, HOST_ADAPTERS, TERMINAL_ADAPTERS, type AdapterTable } from './adapters.ts';

/** Loads the module a specifier names. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/**
 * The importer teamrig runs with. It lives in this file because a relative specifier resolves against the file
 * whose `import()` takes it, and the table's folders are relative to this folder.
 */
export const importModule: ModuleImporter = (specifier) => import(specifier);

/** What came of loading one adapter by its id: the thing asked for, or every reason it was refused. Never a throw. */
export type Load<T> = { readonly kind: 'loaded'; readonly id: string; readonly value: T } | { readonly kind: 'refused'; readonly id: string; readonly notices: readonly string[] };

/** The two fields of a declaration the loader checks beyond its shape. */
interface Declared {
  readonly id: string;
  readonly apiVersion: string;
}

/** One thing the loader reads of an adapter: which file of its folder holds it, under which export, and what makes it sound. */
interface Part<T> {
  readonly side: FeatureSide;
  readonly table: AdapterTable;
  /** Node imports no folder, so the file is named. */
  readonly file: string;
  readonly exported: string;
  readonly problems: (value: unknown) => readonly string[];
  readonly accepts: (value: unknown) => value is T;
  readonly declared: (value: T) => Declared;
}

const DECLARATION_FILE = 'declaration.ts';
const ENTRY_FILE = 'index.ts';

const HOST_DECLARATION: Part<HostDeclaration> = {
  side: 'host',
  table: HOST_ADAPTERS,
  file: DECLARATION_FILE,
  exported: 'declaration',
  problems: hostDeclarationProblems,
  accepts: isHostDeclaration,
  declared: (declaration) => declaration,
};

const HOST_ENTRY: Part<HostAdapter> = {
  side: 'host',
  table: HOST_ADAPTERS,
  file: ENTRY_FILE,
  exported: 'default',
  problems: hostAdapterProblems,
  accepts: isHostAdapter,
  declared: (adapter) => adapter.declaration,
};

const CONNECTOR_DECLARATION: Part<ConnectorDeclaration> = {
  side: 'connector',
  table: CONNECTOR_ADAPTERS,
  file: DECLARATION_FILE,
  exported: 'declaration',
  problems: connectorDeclarationProblems,
  accepts: isConnectorDeclaration,
  declared: (declaration) => declaration,
};

const CONNECTOR_ENTRY: Part<ConnectorAdapter> = {
  side: 'connector',
  table: CONNECTOR_ADAPTERS,
  file: ENTRY_FILE,
  exported: 'default',
  problems: connectorAdapterProblems,
  accepts: isConnectorAdapter,
  declared: (adapter) => adapter.declaration,
};

const TERMINAL_DECLARATION: Part<TerminalDeclaration> = {
  side: 'terminal',
  table: TERMINAL_ADAPTERS,
  file: DECLARATION_FILE,
  exported: 'declaration',
  problems: terminalDeclarationProblems,
  accepts: isTerminalDeclaration,
  declared: (declaration) => declaration,
};

const TERMINAL_ENTRY: Part<TerminalAdapter> = {
  side: 'terminal',
  table: TERMINAL_ADAPTERS,
  file: ENTRY_FILE,
  exported: 'default',
  problems: terminalAdapterProblems,
  accepts: isTerminalAdapter,
  declared: (adapter) => adapter.declaration,
};

function refused<T>(id: string, notices: readonly string[]): Load<T> {
  return { kind: 'refused', id, notices };
}

/** Why a sound part still cannot load under `id`: the table and the adapter disagree on its id, or it is built for another plugin API. */
function mismatches(id: string, declared: Declared): readonly string[] {
  const version = apiVersionNotice(declared.apiVersion, API_VERSION);
  return [...(declared.id === id ? [] : [`it declares the id ${declared.id}, and the adapter table names it ${id}`]), ...(version === undefined ? [] : [version])];
}

async function load<T>(part: Part<T>, id: string, importer: ModuleImporter): Promise<Load<T>> {
  const folder = Object.hasOwn(part.table, id) ? part.table[id] : undefined;
  if (folder === undefined) {
    return refused(id, [`no ${part.side} adapter is named ${id}: the ${part.side} adapters are ${Object.keys(part.table).join(', ')}`]);
  }
  let module: unknown;
  try {
    module = await importer(`${folder}/${part.file}`);
  } catch (error) {
    return refused(id, [`its ${part.file} did not load: ${errorMessage(error)}`]);
  }
  const value = isRecord(module) ? module[part.exported] : undefined;
  if (!part.accepts(value)) {
    return refused(id, part.problems(value));
  }
  const notices = mismatches(id, part.declared(value));
  return notices.length === 0 ? { kind: 'loaded', id, value } : refused(id, notices);
}

function loadAll<T>(part: Part<T>, importer: ModuleImporter): Promise<readonly Load<T>[]> {
  return Promise.all(Object.keys(part.table).map((id) => load(part, id, importer)));
}

/** The host adapter named `id`, checked and ready to build its ports. */
export function loadHost(id: string, importer: ModuleImporter = importModule): Promise<Load<HostAdapter>> {
  return load(HOST_ENTRY, id, importer);
}

/** The connector adapter named `id`, checked and ready to build its ports. */
export function loadConnector(id: string, importer: ModuleImporter = importModule): Promise<Load<ConnectorAdapter>> {
  return load(CONNECTOR_ENTRY, id, importer);
}

/** The terminal adapter named `id`, checked and ready to build its ports. */
export function loadTerminal(id: string, importer: ModuleImporter = importModule): Promise<Load<TerminalAdapter>> {
  return load(TERMINAL_ENTRY, id, importer);
}

/** What every adapter of the table says of itself, in table order. */
export interface Declarations {
  readonly hosts: readonly Load<HostDeclaration>[];
  readonly connectors: readonly Load<ConnectorDeclaration>[];
  readonly terminals: readonly Load<TerminalDeclaration>[];
}

/** Reads each adapter's declaration file alone: the parity page and the checks need no adapter code to run. */
export async function readDeclarations(importer: ModuleImporter = importModule): Promise<Declarations> {
  const [hosts, connectors, terminals] = await Promise.all([
    loadAll(HOST_DECLARATION, importer),
    loadAll(CONNECTOR_DECLARATION, importer),
    loadAll(TERMINAL_DECLARATION, importer),
  ]);
  return { hosts, connectors, terminals };
}
