import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The checkout these tools belong to, two folders above tools/lib. A tool works on its own repo's files from here,
 * never from the cwd: a run from another project's folder wrote a stray docs page there and checked that folder's
 * files instead of its own (T978).
 */
export const TOOLS_REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** A tool's arguments with `--root <folder>` taken out. */
export interface RootedArgs {
  /** The repo the tool works on: the `--root` folder resolved from the cwd, else TOOLS_REPO. */
  readonly root: string;
  /** The other arguments, in their order. */
  readonly rest: readonly string[];
}

/**
 * Takes `--root <folder>` out of a tool's arguments; the specs pass it to point a tool at a temp repo.
 * Throws when the folder is missing or `--root` is given twice.
 */
export function takeRoot(args: readonly string[]): RootedArgs {
  const at = args.indexOf('--root');
  if (at === -1) return { root: TOOLS_REPO, rest: args };
  const folder = args[at + 1];
  if (folder === undefined || folder.startsWith('--')) throw new Error('--root needs a folder');
  const rest = [...args.slice(0, at), ...args.slice(at + 2)];
  if (rest.includes('--root')) throw new Error('--root is given twice');
  return { root: resolve(folder), rest };
}
