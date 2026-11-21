import { adapterEntry, declarationProblems } from "./declaration.js";
/** The default export of a host adapter's entry. */
export function defineHost(adapter) {
    return adapter;
}
export function hostDeclarationProblems(value) {
    return declarationProblems('host', value);
}
export function isHostDeclaration(value) {
    return hostDeclarationProblems(value).length === 0;
}
/** What stops `value` from being a host adapter's entry; empty when it is one. */
export function hostAdapterProblems(value) {
    const entry = adapterEntry(value);
    return entry === undefined ? ['its entry is not made by defineHost: it needs a declaration and a create function'] : hostDeclarationProblems(entry.declaration);
}
export function isHostAdapter(value) {
    return hostAdapterProblems(value).length === 0;
}
