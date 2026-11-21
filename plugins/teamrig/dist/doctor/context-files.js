import { dirname, join } from 'node:path';
import { descriptionOf, splitFrontmatter } from "../skills/lint.js";
import { SkillDir } from "../skills/store.js";
/** The project folder, then each parent up to the filesystem root. */
export function foldersUp(project) {
    const folders = [project];
    for (let parent = dirname(project); parent !== folders.at(-1); parent = dirname(parent)) {
        folders.push(parent);
    }
    return folders;
}
/** The instruction files every session in `project` loads: the person's own, then those of the project folder and each of its parents. */
export function instructionPaths(paths, userHome, project) {
    const nearby = foldersUp(project).flatMap((folder) => paths.folderInstructions(folder));
    return [...new Set([paths.userInstructions(userHome), ...nearby])];
}
/** The skills folders a session in `project` lists: the team's, then the project's own, which only the host's paths tell. */
export function skillFolders(paths, teamSkills, project) {
    return [...new Set([join(teamSkills), ...(paths === undefined ? [] : [paths.projectSkills(project)])])];
}
async function measure(files, path) {
    const text = await files.read(path);
    return text === undefined ? undefined : { path, chars: text.length };
}
/** The line the host lists a skill by: its name and its frontmatter description. */
function listingLine(name, text) {
    return `- ${name}: ${descriptionOf(splitFrontmatter(text).front) ?? ''}\n`;
}
/**
 * Measures what the host puts in every call of a session in `at.project`: the instruction files, the project's
 * memory index and the skill listing of the team's and the project's skills folders. It only reads.
 * `readSessionLists` (session-lists.ts) measures the whole lists a session holds, plugin skills and connector tools
 * too.
 */
export async function readContextFiles(files, at) {
    const { paths } = at;
    const instructions = paths === undefined ? [] : instructionPaths(paths, at.userHome, at.project);
    const claudeMd = (await Promise.all(instructions.map((path) => measure(files, path)))).filter((file) => file !== undefined);
    const memoryIndex = paths === undefined ? undefined : await measure(files, paths.memoryIndex(at.userHome, at.project));
    const folders = skillFolders(paths, at.skills, at.project);
    const skills = (await Promise.all(folders.map((folder) => new SkillDir(files, folder).readAll()))).flat();
    const chars = skills.reduce((sum, skill) => sum + listingLine(skill.name, skill.text).length, 0);
    return { claudeMd, memoryIndex, skills: { folders, count: skills.length, chars } };
}
