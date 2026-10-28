import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { samePath } from '../core/paths.ts';

/**
 * The Claude Code settings files whose allow rules a team's sessions run under: the person's own user settings, and
 * each project folder's shared and local settings, in the folder itself and in each worktree Claude Code made under
 * its `.claude/worktrees` (a worktree's local settings keep the rules "Yes, don't ask again" wrote while a session
 * worked there).
 */

/** `user` and `local` files are the person's own, so a trim rewrites them; a `shared` one is committed with its repo, so a trim only reports it. */
export type SettingsKind = 'user' | 'local' | 'shared';

export interface SettingsFile {
  readonly path: string;
  readonly kind: SettingsKind;
  /** For a file in one of a project's `.claude/worktrees`, the same file in that project folder. */
  readonly projectFile?: string;
}

/** Where Claude Code makes a project's worktrees, from the project folder. */
const WORKTREES = ['.claude', 'worktrees'] as const;

/** A folder's settings files under its `.claude`, with their kinds. */
const FOLDER_FILES = [
  ['settings.json', 'shared'],
  ['settings.local.json', 'local'],
] as const;

function projectFiles(folder: string): SettingsFile[] {
  return FOLDER_FILES.map(([name, kind]) => ({ path: join(folder, '.claude', name), kind }));
}

function worktreeFiles(folder: string, worktree: string): SettingsFile[] {
  return FOLDER_FILES.map(([name, kind]) => ({ path: join(worktree, '.claude', name), kind, projectFile: join(folder, '.claude', name) }));
}

/** The user settings, then each project folder's files and its worktrees' in name order; a path named twice is listed once, as first named. */
export async function settingsScope(files: Files, claudeDir: string, projects: readonly string[], platform: NodeJS.Platform): Promise<SettingsFile[]> {
  const scope: SettingsFile[] = [{ path: join(claudeDir, 'settings.json'), kind: 'user' }];
  for (const folder of projects) {
    const worktrees = join(folder, ...WORKTREES);
    const names = (await files.list(worktrees)).sort((left, right) => left.localeCompare(right));
    scope.push(...projectFiles(folder), ...names.flatMap((name) => worktreeFiles(folder, join(worktrees, name))));
  }
  return scope.filter((file, index) => scope.findIndex((other) => samePath(other.path, file.path, platform)) === index);
}
