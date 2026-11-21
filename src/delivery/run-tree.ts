import type { QueuedStepRecord } from './ledger.ts';

/**
 * The tree a host step ran on, as its log and its ledger record name it (#708), so a log cited as proof for a review
 * names the head it ran on: inside a git repository, its top level, HEAD's commit (null before the first commit) and
 * whether anything was uncommitted or untracked; outside one, only that.
 */
export type RunTree =
  | { readonly kind: 'git'; readonly top: string; readonly head: string | null; readonly dirty: boolean }
  | { readonly kind: 'outside' };

/** A tree as a log names it: `<top> at <commit>, clean`, or that it is outside git. */
export function treeText(tree: RunTree): string {
  return tree.kind === 'outside' ? 'none, it ran outside a git repository' : `${tree.top} at ${tree.head ?? 'no commit yet'}, ${tree.dirty ? 'with uncommitted changes' : 'clean'}`;
}

/** A log's first lines: the folder the step ran in and its tree. */
export function treeHeader(cwd: string, tree: RunTree): string {
  return `# folder: ${cwd}\n# git: ${treeText(tree)}\n`;
}

/** The ledger fields a step's tree fills: each optional, so the records an older teamrig wrote still read. */
export type RunTreeFields = Pick<QueuedStepRecord, 'cwd' | 'gitTop' | 'head' | 'dirty'>;

/** A step's folder and tree as its ledger record stores them: outside git, only the folder. */
export function treeFieldsOf(cwd: string, tree: RunTree): RunTreeFields {
  return tree.kind === 'outside' ? { cwd } : { cwd, gitTop: tree.top, ...(tree.head === null ? {} : { head: tree.head }), dirty: tree.dirty };
}
