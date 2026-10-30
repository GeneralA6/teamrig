import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { expandHome, pathKey, samePath } from "../core/paths.js";
import { claudeMdPaths, claudeMemoryDir, skillFolders } from "../doctor/context-files.js";
import { markdownBelow } from "../rules/places.js";
import { descriptionOf, frontmatterValue, splitFrontmatter } from "../skills/lint.js";
import { SkillDir } from "../skills/store.js";
/** Claude Code loads this many lines of the memory index. */
export const MEMORY_INDEX_LINES = 200;
/** Claude Code follows `@path` imports this many hops deep. */
export const IMPORT_DEPTH = 5;
/** Fenced blocks and inline code spans, where an `@` is not an import. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
/** An `@path` import: an `@` at a line's start or after a space, so an e-mail address is not one. */
const IMPORT = /(?:^|\s)@(\S+)/g;
/** A frontmatter `paths:` key: the rule loads only when a session works on a matching file. */
const PATHS_KEY = /^paths\s*:/m;
/** The extension of an agent type's file. */
const AGENT_FILE = '.md';
/** The files `text` imports, as absolute paths: `~/` from the home folder, a relative one from the importing file's folder. */
export function importsOf(text, importer, userHome) {
    const prose = text.replace(CODE, ' ');
    return Array.from(prose.matchAll(IMPORT), (match) => {
        const path = expandHome(match[1] ?? '', userHome);
        return isAbsolute(path) ? path : resolve(dirname(importer), path);
    });
}
/** The listing line of a skill: `- name: description`, as Claude Code lists it. */
export function listingLineOf(name, description) {
    return `- ${name}: ${description}\n`;
}
/**
 * The listing line of an agent type: its description and the tools its frontmatter `tools` names, `*` with no `tools`
 * key. A `tools` key written as a YAML list reads as none, so its line lists `*`: a few characters short.
 */
export function agentLineOf(name, description, tools) {
    return listingLineOf(name, `${description} (Tools: ${tools ?? '*'})`);
}
/** Reads each path once, in order, as `kind`, skipping a missing file and one already loaded. */
class LoadedFiles {
    files = [];
    seen = new Set();
    reader;
    constructor(reader) {
        this.reader = reader;
    }
    async add(kind, path, cut = (text) => text) {
        if (this.seen.has(pathKey(path))) {
            return undefined;
        }
        const text = await this.reader.read(path);
        return text === undefined ? undefined : this.keep(kind, path, cut(text));
    }
    /** Keeps a file already read, unless it was loaded before. */
    keep(kind, path, text) {
        const key = pathKey(path);
        if (this.seen.has(key)) {
            return undefined;
        }
        this.seen.add(key);
        const file = { kind, path, text };
        this.files.push(file);
        return file;
    }
}
async function addImports(loaded, file, userHome, depth) {
    if (depth > IMPORT_DEPTH) {
        return;
    }
    for (const path of importsOf(file.text, file.path, userHome)) {
        const imported = await loaded.add('import', path);
        if (imported !== undefined) {
            await addImports(loaded, imported, userHome, depth + 1);
        }
    }
}
async function readSkills(files, at) {
    const listed = [];
    for (const folder of skillFolders(at.skills, at.project)) {
        const dir = new SkillDir(files, folder);
        const scope = samePath(folder, at.skills) ? 'user' : 'project';
        for (const skill of await dir.readAll()) {
            const description = descriptionOf(splitFrontmatter(skill.text).front) ?? '';
            listed.push({ name: skill.name, path: dir.pathOf(skill.name), description, line: listingLineOf(skill.name, description), scope });
        }
    }
    return listed;
}
/** The agent types of the `.md` files directly in `folder`: each named by its frontmatter `name`, else its file name. */
async function readAgentFolder(files, folder, scope) {
    const listed = [];
    for (const file of (await files.list(folder)).filter((name) => name.endsWith(AGENT_FILE)).sort()) {
        const path = join(folder, file);
        const text = await files.read(path);
        if (text !== undefined) {
            const front = splitFrontmatter(text).front;
            const name = frontmatterValue(front, 'name') ?? basename(file, AGENT_FILE);
            const description = frontmatterValue(front, 'description') ?? '';
            listed.push({ name, path, description, line: agentLineOf(name, description, frontmatterValue(front, 'tools') ?? undefined), scope });
        }
    }
    return listed;
}
/** The user's agent types (`<claudeDir>/agents`), then the project's (`.claude/agents`), each folder read once. */
async function readAgents(files, at) {
    const user = join(at.claudeDir, 'agents');
    const project = join(at.project, '.claude', 'agents');
    const own = samePath(user, project) ? [] : await readAgentFolder(files, project, 'project');
    return [...(await readAgentFolder(files, user, 'user')), ...own];
}
/**
 * What every session in `at.project` loads at its start: the user's and the project's CLAUDE.md files and the files
 * they import with `@path`, the `.claude/rules` files without a `paths:` frontmatter, the first lines of the memory
 * index, the team's rules, and the listings of the user's and project's skills and agent types. It only reads.
 */
export async function readSessionContext(files, probe, at) {
    const loaded = new LoadedFiles(files);
    for (const path of claudeMdPaths(at.claudeDir, at.project)) {
        const file = await loaded.add('claude-md', path);
        if (file !== undefined) {
            await addImports(loaded, file, at.userHome, 1);
        }
    }
    const rules = [...(await markdownBelow(files, probe, join(at.project, '.claude', 'rules'))), ...(await markdownBelow(files, probe, join(at.claudeDir, 'rules')))];
    for (const path of rules) {
        const text = await files.read(path);
        if (text !== undefined && !PATHS_KEY.test(splitFrontmatter(text).front)) {
            loaded.keep('rules', path, text);
        }
    }
    await loaded.add('memory', join(claudeMemoryDir(at.claudeDir, at.project), 'MEMORY.md'), (text) => text.split('\n').slice(0, MEMORY_INDEX_LINES).join('\n'));
    for (const path of at.teamRules) {
        await loaded.add('team-rules', path);
    }
    return { files: loaded.files, skills: await readSkills(files, at), agents: await readAgents(files, at) };
}
