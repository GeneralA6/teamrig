/** A process as a host list links it: its id and its parent's. */
export interface ProcessLink {
  readonly pid: number;
  readonly parent: number;
}

/** The process `root` and every descendant still running, by parent links; empty when `root` is not listed. */
export function treeOf<Row extends ProcessLink>(root: number, rows: readonly Row[]): Row[] {
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    if (row.pid !== row.parent) {
      children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
    }
  }
  const tree = rows.filter((row) => row.pid === root);
  const seen = new Set(tree.map((row) => row.pid));
  for (let index = 0; index < tree.length; index += 1) {
    for (const child of children.get(tree[index]?.pid ?? -1) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        tree.push(child);
      }
    }
  }
  return tree;
}

/** The lines of a process list that are three whole numbers, split on commas or blanks; any other line is left out. */
export function wholeNumberTriples(text: string): (readonly [number, number, number])[] {
  return text.split(/\r?\n/).flatMap((line): (readonly [number, number, number])[] => {
    const cells = line.trim().split(/[,\s]+/).map(Number);
    const [first, second, third] = cells;
    return cells.length === 3 && first !== undefined && second !== undefined && third !== undefined && cells.every(Number.isSafeInteger) ? [[first, second, third]] : [];
  });
}
