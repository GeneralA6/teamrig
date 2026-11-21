/** A tree as a log names it: `<top> at <commit>, clean`, or that it is outside git. */
export function treeText(tree) {
    return tree.kind === 'outside' ? 'none, it ran outside a git repository' : `${tree.top} at ${tree.head ?? 'no commit yet'}, ${tree.dirty ? 'with uncommitted changes' : 'clean'}`;
}
/** A log's first lines: the folder the step ran in and its tree. */
export function treeHeader(cwd, tree) {
    return `# folder: ${cwd}\n# git: ${treeText(tree)}\n`;
}
/** A step's folder and tree as its ledger record stores them: outside git, only the folder. */
export function treeFieldsOf(cwd, tree) {
    return tree.kind === 'outside' ? { cwd } : { cwd, gitTop: tree.top, ...(tree.head === null ? {} : { head: tree.head }), dirty: tree.dirty };
}
