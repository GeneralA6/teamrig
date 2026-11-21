import { adapterEntry, declarationProblems } from "./declaration.js";
/** The default export of a terminal adapter's entry. */
export function defineTerminal(adapter) {
    return adapter;
}
export function terminalDeclarationProblems(value) {
    return declarationProblems('terminal', value);
}
export function isTerminalDeclaration(value) {
    return terminalDeclarationProblems(value).length === 0;
}
/** What stops `value` from being a terminal adapter's entry; empty when it is one. */
export function terminalAdapterProblems(value) {
    const entry = adapterEntry(value);
    return entry === undefined ? ['its entry is not made by defineTerminal: it needs a declaration and a create function'] : terminalDeclarationProblems(entry.declaration);
}
export function isTerminalAdapter(value) {
    return terminalAdapterProblems(value).length === 0;
}
