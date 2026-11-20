import { dirname, join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { HostPaths } from '../ports/host/index.ts';
import { descriptionOf, splitFrontmatter } from '../skills/lint.ts';
import { SkillDir } from '../skills/store.ts';

/** A file the host puts in a session's context, and its length in characters. */
export interface ContextFile {
  readonly path: string;
  readonly chars: number;
}

/** The text every call of a session in a project re-reads, as `readContextFiles` measures it. */
export interface ContextFiles {
  /** The person's own instruction file, then those of the project folder and each of its parents (`instructionPaths`). */
  readonly claudeMd: readonly ContextFile[];
  /** The project's memory index, when it has one. */
  readonly memoryIndex: ContextFile | undefined;
  /** The skill listing: one `- name: description` line per skill in these folders. */
  readonly skills: { readonly folders: readonly string[]; readonly count: number; readonly chars: number };
}

/** Where the host loads a session's instruction files from. */
export type InstructionPaths = Pick<HostPaths, 'userInstructions' | 'folderInstructions'>;
/** Where the host loads the context files `readContextFiles` measures from. */
export type ContextPaths = InstructionPaths & Pick<HostPaths, 'memoryIndex' | 'projectSkills'>;

export interface ContextFileLocations {
  /** The host's paths; undefined where teamrig does not know the host's folders, and only the team's skills are measured. */
  readonly paths: ContextPaths | undefined;
  readonly userHome: string;
  /** The project folder sessions start in. */
  readonly project: string;
  /** The team's skills folder. */
  readonly skills: string;
}

/** The project folder, then each parent up to the filesystem root. */
export function foldersUp(project: string): string[] {
  const folders = [project];
  for (let parent = dirname(project); parent !== folders.at(-1); parent = dirname(parent)) {
    folders.push(parent);
  }
  return folders;
}

/** The instruction files every session in `project` loads: the person's own, then those of the project folder and each of its parents. */
export function instructionPaths(paths: InstructionPaths, userHome: string, project: string): string[] {
  const nearby = foldersUp(project).flatMap((folder) => paths.folderInstructions(folder));
  return [...new Set([paths.userInstructions(userHome), ...nearby])];
}

/** The skills folders a session in `project` lists: the team's, then the project's own, which only the host's paths tell. */
export function skillFolders(paths: Pick<HostPaths, 'projectSkills'> | undefined, teamSkills: string, project: string): string[] {
  return [...new Set([join(teamSkills), ...(paths === undefined ? [] : [paths.projectSkills(project)])])];
}

async function measure(files: Files, path: string): Promise<ContextFile | undefined> {
  const text = await files.read(path);
  return text === undefined ? undefined : { path, chars: text.length };
}

/** The line the host lists a skill by: its name and its frontmatter description. */
function listingLine(name: string, text: string): string {
  return `- ${name}: ${descriptionOf(splitFrontmatter(text).front) ?? ''}\n`;
}

/**
 * Measures what the host puts in every call of a session in `at.project`: the instruction files, the project's
 * memory index and the skill listing of the team's and the project's skills folders. It only reads.
 * `readSessionLists` (session-lists.ts) measures the whole lists a session holds, plugin skills and connector tools
 * too.
 */
export async function readContextFiles(files: Files, at: ContextFileLocations): Promise<ContextFiles> {
  const { paths } = at;
  const instructions = paths === undefined ? [] : instructionPaths(paths, at.userHome, at.project);
  const claudeMd = (await Promise.all(instructions.map((path) => measure(files, path)))).filter((file): file is ContextFile => file !== undefined);
  const memoryIndex = paths === undefined ? undefined : await measure(files, paths.memoryIndex(at.userHome, at.project));
  const folders = skillFolders(paths, at.skills, at.project);
  const skills = (await Promise.all(folders.map((folder) => new SkillDir(files, folder).readAll()))).flat();
  const chars = skills.reduce((sum, skill) => sum + listingLine(skill.name, skill.text).length, 0);
  return { claudeMd, memoryIndex, skills: { folders, count: skills.length, chars } };
}
