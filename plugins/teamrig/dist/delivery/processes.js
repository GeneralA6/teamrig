/**
 * The process `root` and every descendant still running, by parent links; empty when `root` is not listed. A process
 * listed as started before its parent is left out: the parent it had ended, and its id went to that later process.
 */
export function treeOf(root, rows) {
    const children = new Map();
    for (const row of rows) {
        if (row.pid !== row.parent) {
            children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
        }
    }
    const tree = rows.filter((row) => row.pid === root);
    const seen = new Set(tree.map((row) => row.pid));
    for (let index = 0; index < tree.length; index += 1) {
        const parent = tree[index];
        if (parent === undefined) {
            continue;
        }
        for (const child of children.get(parent.pid) ?? []) {
            if (!seen.has(child.pid) && startedFirst(parent, child)) {
                seen.add(child.pid);
                tree.push(child);
            }
        }
    }
    return tree;
}
/** Whether `parent` started no later than `child`; true where either start is unknown, as in a `ps` list. */
function startedFirst(parent, child) {
    return parent.startedMs === undefined || child.startedMs === undefined || parent.startedMs <= child.startedMs;
}
/** The lines of a process list that are whole numbers, as many as one of `widths`, split on commas or blanks; any other line is left out. */
export function wholeNumberLines(text, widths) {
    return text.split(/\r?\n/).flatMap((line) => {
        const cells = line.trim().split(/[,\s]+/).map(Number);
        return widths.includes(cells.length) && cells.every(Number.isSafeInteger) ? [cells] : [];
    });
}
/** The lines of a process list that are three whole numbers, split on commas or blanks; any other line is left out. */
export function wholeNumberTriples(text) {
    return wholeNumberLines(text, [3]).flatMap(([first, second, third]) => first !== undefined && second !== undefined && third !== undefined ? [[first, second, third]] : []);
}
