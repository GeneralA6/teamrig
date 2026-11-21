var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { errorMessage, isRecord } from "../core/guards.js";
import { API_VERSION, apiVersionNotice, connectorAdapterProblems, connectorDeclarationProblems, hostAdapterProblems, hostDeclarationProblems, isConnectorAdapter, isConnectorDeclaration, isHostAdapter, isHostDeclaration, isTerminalAdapter, isTerminalDeclaration, terminalAdapterProblems, terminalDeclarationProblems, } from "../plugin-api/index.js";
import { CONNECTOR_ADAPTERS, HOST_ADAPTERS, TERMINAL_ADAPTERS } from "./adapters.js";
/**
 * The importer teamrig runs with. It lives in this file because a relative specifier resolves against the file
 * whose `import()` takes it, and the table's folders are relative to this folder.
 */
export const importModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));
const DECLARATION_FILE = 'declaration.ts';
const ENTRY_FILE = 'index.ts';
const HOST_DECLARATION = {
    side: 'host',
    table: HOST_ADAPTERS,
    file: DECLARATION_FILE,
    exported: 'declaration',
    problems: hostDeclarationProblems,
    accepts: isHostDeclaration,
    declared: (declaration) => declaration,
};
const HOST_ENTRY = {
    side: 'host',
    table: HOST_ADAPTERS,
    file: ENTRY_FILE,
    exported: 'default',
    problems: hostAdapterProblems,
    accepts: isHostAdapter,
    declared: (adapter) => adapter.declaration,
};
const CONNECTOR_DECLARATION = {
    side: 'connector',
    table: CONNECTOR_ADAPTERS,
    file: DECLARATION_FILE,
    exported: 'declaration',
    problems: connectorDeclarationProblems,
    accepts: isConnectorDeclaration,
    declared: (declaration) => declaration,
};
const CONNECTOR_ENTRY = {
    side: 'connector',
    table: CONNECTOR_ADAPTERS,
    file: ENTRY_FILE,
    exported: 'default',
    problems: connectorAdapterProblems,
    accepts: isConnectorAdapter,
    declared: (adapter) => adapter.declaration,
};
const TERMINAL_DECLARATION = {
    side: 'terminal',
    table: TERMINAL_ADAPTERS,
    file: DECLARATION_FILE,
    exported: 'declaration',
    problems: terminalDeclarationProblems,
    accepts: isTerminalDeclaration,
    declared: (declaration) => declaration,
};
const TERMINAL_ENTRY = {
    side: 'terminal',
    table: TERMINAL_ADAPTERS,
    file: ENTRY_FILE,
    exported: 'default',
    problems: terminalAdapterProblems,
    accepts: isTerminalAdapter,
    declared: (adapter) => adapter.declaration,
};
function refused(id, notices) {
    return { kind: 'refused', id, notices };
}
/** Why a sound part still cannot load under `id`: the table and the adapter disagree on its id, or it is built for another plugin API. */
function mismatches(id, declared) {
    const version = apiVersionNotice(declared.apiVersion, API_VERSION);
    return [...(declared.id === id ? [] : [`it declares the id ${declared.id}, and the adapter table names it ${id}`]), ...(version === undefined ? [] : [version])];
}
async function load(part, id, importer) {
    const folder = Object.hasOwn(part.table, id) ? part.table[id] : undefined;
    if (folder === undefined) {
        return refused(id, [`no ${part.side} adapter is named ${id}: the ${part.side} adapters are ${Object.keys(part.table).join(', ')}`]);
    }
    let module;
    try {
        module = await importer(`${folder}/${part.file}`);
    }
    catch (error) {
        return refused(id, [`its ${part.file} did not load: ${errorMessage(error)}`]);
    }
    const value = isRecord(module) ? module[part.exported] : undefined;
    if (!part.accepts(value)) {
        return refused(id, part.problems(value));
    }
    const notices = mismatches(id, part.declared(value));
    return notices.length === 0 ? { kind: 'loaded', id, value } : refused(id, notices);
}
function loadAll(part, importer) {
    return Promise.all(Object.keys(part.table).map((id) => load(part, id, importer)));
}
/** The host adapter named `id`, checked and ready to build its ports. */
export function loadHost(id, importer = importModule) {
    return load(HOST_ENTRY, id, importer);
}
/** The connector adapter named `id`, checked and ready to build its ports. */
export function loadConnector(id, importer = importModule) {
    return load(CONNECTOR_ENTRY, id, importer);
}
/** The terminal adapter named `id`, checked and ready to build its ports. */
export function loadTerminal(id, importer = importModule) {
    return load(TERMINAL_ENTRY, id, importer);
}
/** Reads each adapter's declaration file alone: the parity page and the checks need no adapter code to run. */
export async function readDeclarations(importer = importModule) {
    const [hosts, connectors, terminals] = await Promise.all([
        loadAll(HOST_DECLARATION, importer),
        loadAll(CONNECTOR_DECLARATION, importer),
        loadAll(TERMINAL_DECLARATION, importer),
    ]);
    return { hosts, connectors, terminals };
}
