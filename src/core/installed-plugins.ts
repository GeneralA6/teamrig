/**
 * Which plugin installs apply to a project, from the installs the host's plugin port reads (`ports/host/plugin.ts`).
 * The tab's reload hand reads them to see an update (`mod/reload-hand.ts`). The mod runs inside the host without Node,
 * so this file imports nothing from Node.
 */
import type { PluginInstall } from '../ports/host/plugin.ts';

/** A path with a drive letter or a UNC start: Windows, where case and the slash's direction do not matter. */
const WINDOWS_PATH = /^(?:[A-Za-z]:|[\\/]{2})/;

function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    end -= 1;
  }
  return path.slice(0, end);
}

/** Whether two spellings name one folder; on Windows `\` and `/` are one separator and case does not matter. */
export function samePath(a: string, b: string): boolean {
  if (WINDOWS_PATH.test(a) || WINDOWS_PATH.test(b)) {
    const windows = (path: string): string => withoutTrailingSlash(path.replaceAll('\\', '/')).toLowerCase();
    return windows(a) === windows(b);
  }
  return withoutTrailingSlash(a) === withoutTrailingSlash(b);
}

/** Whether an install applies to a tab whose project root is `projectRoot`: one for every project always, one for a project for that project only, one of a reach the core does not know never. */
export function appliesTo(install: PluginInstall, projectRoot: string): boolean {
  const { reach } = install;
  return reach.kind === 'every project' || (reach.kind === 'project' && samePath(reach.path, projectRoot));
}
