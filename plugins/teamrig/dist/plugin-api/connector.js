import { isRecord, stringField } from "../core/guards.js";
import { featuresOf, isConnectorKind } from "../features/registry.js";
import { adapterEntry, declarationProblems } from "./declaration.js";
import { isSupport } from "./support.js";
/** The default export of a connector adapter's entry. */
export function defineConnector(adapter) {
    return adapter;
}
const REF_PREFIX = /^[a-z][a-z0-9-]*:$/;
function kindsOf(declaration) {
    const kinds = declaration['kinds'];
    if (!Array.isArray(kinds) || kinds.length === 0 || new Set(kinds).size !== kinds.length) {
        return undefined;
    }
    return kinds.every(isConnectorKind) ? kinds : undefined;
}
/** The rows that claim a feature of a kind the connector does not declare. */
function strayKindProblems(kinds, manifest) {
    if (!isRecord(manifest)) {
        return [];
    }
    return featuresOf('connector').flatMap((row) => {
        const support = manifest[row.id];
        const stray = !kinds.some((kind) => kind === row.group) && isSupport(support) && support.kind !== 'unsupported';
        return stray ? [`${row.id} is not unsupported, but its kinds do not list ${row.group}`] : [];
    });
}
export function connectorDeclarationProblems(value) {
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
export function isConnectorDeclaration(value) {
    return connectorDeclarationProblems(value).length === 0;
}
/** What stops `value` from being a connector adapter's entry; empty when it is one. */
export function connectorAdapterProblems(value) {
    const entry = adapterEntry(value);
    return entry === undefined ? ['its entry is not made by defineConnector: it needs a declaration and a create function'] : connectorDeclarationProblems(entry.declaration);
}
export function isConnectorAdapter(value) {
    return connectorAdapterProblems(value).length === 0;
}
