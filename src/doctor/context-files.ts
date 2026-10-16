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

const CLAUDE_MD_FILES: readonly (readonly string[])[] = [['CLAUDE.md'], ['CLAUDE.local.md'], ['.claude', 'CLAUDE.md']];

/** The project folder, then each parent up to the filesystem root. */
function foldersUp(project: string): string[] {
  const folders = [project];
  for (let parent = dirname(project); parent !== folders.at(-1); parent = dirname(parent)) {
    folders.push(parent);
  }
  return folders;
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
 * team's and the project's skills folders. Plugin skills and connector tools are not counted. It only reads.
 */
export async function readContextFiles(files: Files, at: ContextFileLocations): Promise<ContextFiles> {
  const nearby = foldersUp(at.project).flatMap((folder) => CLAUDE_MD_FILES.map((parts) => join(folder, ...parts)));
  const claudeMdPaths = [...new Set([join(at.claudeDir, 'CLAUDE.md'), ...nearby])];
  const claudeMd = (await Promise.all(claudeMdPaths.map((path) => measure(files, path)))).filter((file): file is ContextFile => file !== undefined);
  const memoryIndex = await measure(files, join(at.claudeDir, 'projects', claudeProjectSlug(at.project), 'memory', 'MEMORY.md'));
  const folders = [...new Set([join(at.skills), join(at.project, '.claude', 'skills')])];
  const skills = (await Promise.all(folders.map((folder) => new SkillDir(files, folder).readAll()))).flat();
  const chars = skills.reduce((sum, skill) => sum + listingLine(skill.name, skill.text).length, 0);
  return { claudeMd, memoryIndex, skills: { folders, count: skills.length, chars } };
}
