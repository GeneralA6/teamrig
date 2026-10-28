import { posix, win32, type PlatformPath } from 'node:path';
import { claudeProjectSlug } from '../budget/discover.ts';
import { stringField } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { pathKey, samePath } from '../core/paths.ts';

/**
 * The folder Claude Code resumes a session in (T1408). `claude --resume` finds a transcript only in the project folder
 * named for the folder it runs in (`claudeProjectSlug`), and a session's transcript sits in the one of the folder its
 * Claude Code started in, which need not be the team's project: a session started in a subfolder or a worktree has
 * it there. The candidates are `project`, where `teamrig open` starts the session, then each folder the transcript's
 * entries ran in (their `cwd`, newest first) and its parents; the first whose project folder holds `transcript` is
 * the one. Undefined when none does: such a session could not be resumed once closed.
 */
export function resumeFolderOf(transcript: string, tail: string, project: string, projectsDir: string, platform: NodeJS.Platform): string | undefined {
  const path = platform === 'win32' ? win32 : posix;
  const folder = path.dirname(transcript);
  const files = (candidate: string): boolean => samePath(folder, path.join(projectsDir, claudeProjectSlug(candidate)), platform);
  if (files(project)) {
    return project;
  }
  return entryFoldersOf(tail, path, platform).find(files);
}

/** The folders a transcript tail's entries ran in, newest first, each followed by its parents, each once. */
function entryFoldersOf(tail: string, path: PlatformPath, platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseObject((lines[index] ?? '').trim());
    const cwd = entry === undefined ? undefined : stringField(entry, 'cwd');
    for (let at = cwd; at !== undefined && at !== '' && !seen.has(pathKey(at, platform)); at = parentOf(path, at)) {
      seen.add(pathKey(at, platform));
      folders.push(at);
    }
  }
  return folders;
}

/** The folder above `folder`; undefined at a root. */
function parentOf(path: PlatformPath, folder: string): string | undefined {
  const parent = path.dirname(folder);
  return parent === folder ? undefined : parent;
}
