/** A process as a host list links it: its id and its parent's. */
export interface ProcessLink {
  readonly pid: number;
  readonly parent: number;
  /** When it started, in ms since 1970, where the host says (Windows; 0 for its own processes), to tell it from an ended process with its id. */
  readonly startedMs?: number;
}

/**
 * The process `root` and every descendant still running, by parent links; empty when `root` is not listed. A process
 * listed as started before its parent is left out: the parent it had ended, and its id went to that later process.
 */
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
function startedFirst(parent: ProcessLink, child: ProcessLink): boolean {
  return parent.startedMs === undefined || child.startedMs === undefined || parent.startedMs <= child.startedMs;
}

/** The lines of a process list that are whole numbers, as many as one of `widths`, split on commas or blanks; any other line is left out. */
export function wholeNumberLines(text: string, widths: readonly number[]): (readonly number[])[] {
  return text.split(/\r?\n/).flatMap((line): (readonly number[])[] => {
    const cells = line.trim().split(/[,\s]+/).map(Number);
    return widths.includes(cells.length) && cells.every(Number.isSafeInteger) ? [cells] : [];
  });
}

/** The lines of a process list that are three whole numbers, split on commas or blanks; any other line is left out. */
export function wholeNumberTriples(text: string): (readonly [number, number, number])[] {
  return wholeNumberLines(text, [3]).flatMap(([first, second, third]): (readonly [number, number, number])[] =>
    first !== undefined && second !== undefined && third !== undefined ? [[first, second, third]] : [],
  );
}
