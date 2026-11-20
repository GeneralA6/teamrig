import { join, relative } from 'node:path';
import type { Files } from '../core/files.ts';
import { samePath } from '../core/paths.ts';
import type { HostPaths } from '../ports/host/index.ts';

/**
 * The host's settings files whose allow rules a team's sessions run under: the person's own user settings, and each
 * project folder's shared and local settings, in the folder itself and in each worktree the host made for it (a
 * worktree's local settings keep the rules "Yes, don't ask again" wrote while a session worked there). The host's
 * paths name every one of them, so no file or folder name of the host's is joined here.
 */

/** Where the host keeps one person's settings: its paths, and the home folder of that person. */
export interface SettingsHost {
  readonly paths: Pick<HostPaths, 'userSettings' | 'folderSettings' | 'worktrees'>;
  readonly userHome: string;
}

/**
 * `user` and `local` files are the person's own, so a trim rewrites them; a `shared` one is committed with its repo, so a
 * trim only reports it. A project's `settings.json` is `shared` unless git says its repository does not track it
 * (`ownUntracked`).
 */
export type SettingsKind = 'user' | 'local' | 'shared';

export interface SettingsFile {
  readonly path: string;
  readonly kind: SettingsKind;
  /** For a file in one of the worktrees the host made for a project, the same file in that project folder. */
  readonly projectFile?: string;
}

/** A worktree's settings files, each with the file at the same place under the project folder it was made for. */
function worktreeFiles(paths: SettingsHost['paths'], folder: string, worktree: string): SettingsFile[] {
  return paths.folderSettings(worktree).map((file) => ({ ...file, projectFile: join(folder, relative(worktree, file.path)) }));
}

/** The user settings, then each project folder's files and its worktrees' in name order; a path named twice is listed once, as first named. */
export async function settingsScope(files: Files, { paths, userHome }: SettingsHost, projects: readonly string[], platform: NodeJS.Platform): Promise<SettingsFile[]> {
  const scope: SettingsFile[] = [{ path: paths.userSettings(userHome), kind: 'user' }];
  for (const folder of projects) {
    const worktrees = paths.worktrees(folder);
    const names = (await files.list(worktrees)).sort((left, right) => left.localeCompare(right));
    scope.push(...paths.folderSettings(folder), ...names.flatMap((name) => worktreeFiles(paths, folder, join(worktrees, name))));
  }
  return scope.filter((file, index) => scope.findIndex((other) => samePath(other.path, file.path, platform)) === index);
}

/** Where git holds a project's `settings.json`: committed, not (ignored, or never added), or unknown (no repository, or git could not tell). */
export type SettingsInGit = 'tracked' | 'untracked' | 'unknown';

/**
 * The scope with each existing `shared` file that git does not track read as the person's own (`local`): a repository
 * that ignores `.claude/` commits no `settings.json`, so no commit can change it, and only a trim can (#837). One git
 * can not tell about stays `shared`, as does one not there (nothing to trim, and no git run spent on it).
 */
export async function ownUntracked(files: Files, scope: readonly SettingsFile[], inGit: (path: string) => SettingsInGit): Promise<SettingsFile[]> {
  return Promise.all(
    scope.map(async (file): Promise<SettingsFile> =>
      file.kind === 'shared' && (await files.modifiedAt(file.path)) !== undefined && inGit(file.path) === 'untracked' ? { ...file, kind: 'local' } : file,
    ),
  );
}
