import { dirname, join } from 'node:path';
import { claudeProjectSlug } from '../budget/discover.ts';
import type { Files } from '../core/files.ts';
import { descriptionOf, splitFrontmatter } from '../skills/lint.ts';
import { SkillDir } from '../skills/store.ts';

/** A file Claude Code puts in a session's context, and its length in characters. */
export interface ContextFile {
  readonly path: string;
  readonly chars: number;
}

/** The text every call of a session in a project re-reads, as `readContextFiles` measures it. */
export interface ContextFiles {
  /** The user's CLAUDE.md, then each of the project folder and its parents (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`). */
  readonly claudeMd: readonly ContextFile[];
  /** The project's memory index, when it has one. */
  readonly memoryIndex: ContextFile | undefined;
  /** The skill listing: one `- name: description` line per skill in these folders. */
  readonly skills: { readonly folders: readonly string[]; readonly count: number; readonly chars: number };
}

export interface ContextFileLocations {
  /** Claude Code's own folder (`claudeConfigDir`). */
  readonly claudeDir: string;
  /** The project folder sessions start in. */
  readonly project: string;
  /** The team's skills folder. */
  readonly skills: string;
}

/** The CLAUDE.md files Claude Code reads in a folder, as path parts below it. */
export const CLAUDE_MD_FILES: readonly (readonly string[])[] = [['CLAUDE.md'], ['CLAUDE.local.md'], ['.claude', 'CLAUDE.md']];

/** The project folder, then each parent up to the filesystem root. */
function foldersUp(project: string): string[] {
  const folders = [project];
  for (let parent = dirname(project); parent !== folders.at(-1); parent = dirname(parent)) {
    folders.push(parent);
  }
  return folders;
}

/** The CLAUDE.md files every session in `project` loads: the user's, then each of the project folder and its parents. */
export function claudeMdPaths(claudeDir: string, project: string): string[] {
  const nearby = foldersUp(project).flatMap((folder) => CLAUDE_MD_FILES.map((parts) => join(folder, ...parts)));
  return [...new Set([join(claudeDir, 'CLAUDE.md'), ...nearby])];
}

/** The project's memory folder, `<claudeDir>/projects/<slug>/memory`, where Claude Code keeps MEMORY.md and its files. */
export function claudeMemoryDir(claudeDir: string, project: string): string {
  return join(claudeDir, 'projects', claudeProjectSlug(project), 'memory');
}

/** The skills folders a session in `project` lists: the team's, then the project's own `.claude/skills`. */
export function skillFolders(teamSkills: string, project: string): string[] {
  return [...new Set([join(teamSkills), join(project, '.claude', 'skills')])];
}

async function measure(files: Files, path: string): Promise<ContextFile | undefined> {
  const text = await files.read(path);
  return text === undefined ? undefined : { path, chars: text.length };
}

/** The line Claude Code lists a skill by: its name and its frontmatter description. */
function listingLine(name: string, text: string): string {
  return `- ${name}: ${descriptionOf(splitFrontmatter(text).front) ?? ''}\n`;
}

/**
 * Measures what Claude Code puts in every call of a session in `at.project`: the CLAUDE.md files, the
 * project's memory index (`<claudeDir>/projects/<slug>/memory/MEMORY.md`) and the skill listing of the
 * team's and the project's skills folders. It only reads. `readSessionLists` (session-lists.ts) measures the
 * whole lists a session holds, plugin skills and connector tools too.
 */
export async function readContextFiles(files: Files, at: ContextFileLocations): Promise<ContextFiles> {
  const paths = claudeMdPaths(at.claudeDir, at.project);
  const claudeMd = (await Promise.all(paths.map((path) => measure(files, path)))).filter((file): file is ContextFile => file !== undefined);
  const memoryIndex = await measure(files, join(claudeMemoryDir(at.claudeDir, at.project), 'MEMORY.md'));
  const folders = skillFolders(at.skills, at.project);
  const skills = (await Promise.all(folders.map((folder) => new SkillDir(files, folder).readAll()))).flat();
  const chars = skills.reduce((sum, skill) => sum + listingLine(skill.name, skill.text).length, 0);
  return { claudeMd, memoryIndex, skills: { folders, count: skills.length, chars } };
}
