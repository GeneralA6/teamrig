import { dirname, join } from 'node:path';
import { claudeProjectSlug } from "../budget/discover.js";
import { descriptionOf, splitFrontmatter } from "../skills/lint.js";
import { SkillDir } from "../skills/store.js";
const CLAUDE_MD_FILES = [['CLAUDE.md'], ['CLAUDE.local.md'], ['.claude', 'CLAUDE.md']];
/** The project folder, then each parent up to the filesystem root. */
function foldersUp(project) {
    const folders = [project];
    for (let parent = dirname(project); parent !== folders.at(-1); parent = dirname(parent)) {
        folders.push(parent);
    }
    return folders;
}
async function measure(files, path) {
    const text = await files.read(path);
    return text === undefined ? undefined : { path, chars: text.length };
}
/** The line Claude Code lists a skill by: its name and its frontmatter description. */
function listingLine(name, text) {
    return `- ${name}: ${descriptionOf(splitFrontmatter(text).front) ?? ''}\n`;
}
/**
 * Measures what Claude Code puts in every call of a session in `at.project`: the CLAUDE.md files, the
 * project's memory index (`<claudeDir>/projects/<slug>/memory/MEMORY.md`) and the skill listing of the
 * team's and the project's skills folders. Plugin skills and connector tools are not counted. It only reads.
 */
export async function readContextFiles(files, at) {
    const nearby = foldersUp(at.project).flatMap((folder) => CLAUDE_MD_FILES.map((parts) => join(folder, ...parts)));
    const claudeMdPaths = [...new Set([join(at.claudeDir, 'CLAUDE.md'), ...nearby])];
    const claudeMd = (await Promise.all(claudeMdPaths.map((path) => measure(files, path)))).filter((file) => file !== undefined);
    const memoryIndex = await measure(files, join(at.claudeDir, 'projects', claudeProjectSlug(at.project), 'memory', 'MEMORY.md'));
    const folders = [...new Set([join(at.skills), join(at.project, '.claude', 'skills')])];
    const skills = (await Promise.all(folders.map((folder) => new SkillDir(files, folder).readAll()))).flat();
    const chars = skills.reduce((sum, skill) => sum + listingLine(skill.name, skill.text).length, 0);
    return { claudeMd, memoryIndex, skills: { folders, count: skills.length, chars } };
}
