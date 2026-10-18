import type { IntegrateGit } from './git.ts';
import { installTouches, MANIFEST_FILE, packageFilesChange } from './manifest.ts';

/** The git reads a range's dependency check needs. */
export type RangeReader = Pick<IntegrateGit, 'changedPaths' | 'fileAt'>;

/**
 * The root package files the commits `from..to` of the checkout at `dir` change in a way that needs a dependency
 * install, as `installTouches` names them: empty when none does, undefined when the range's paths could not be read.
 */
export async function rangeInstallTouches(git: RangeReader, dir: string, from: string, to: string): Promise<string[] | undefined> {
  const paths = git.changedPaths(dir, from, to);
  if (paths === undefined) {
    return undefined;
  }
  return installTouches(await packageFilesChange(paths, async (end) => git.fileAt(dir, end === 'before' ? from : to, MANIFEST_FILE)));
}
