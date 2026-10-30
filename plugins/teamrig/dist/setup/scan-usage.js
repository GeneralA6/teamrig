import { readLines } from "../budget/cursor.js";
import { discoverTranscripts } from "../budget/discover.js";
import { AGENT_TOOL, parseTranscriptLine, SKILL_TOOL } from "../budget/line.js";
import { stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { isAtOrBelow, pathKey } from "../core/paths.js";
/** The bytes read at a time: a transcript runs to hundreds of MB, and is never held whole. */
export const USE_CHUNK_BYTES = 8 * 1024 * 1024;
/** A cheap test before parsing: only a line naming the Skill or Agent tool or a slash command can show a use. */
function mayNameUse(line) {
    return line.includes(`"${SKILL_TOOL}"`) || line.includes(`"${AGENT_TOOL}"`) || line.includes('<command-name>');
}
function addCwd(line, one) {
    if (one.cwd === undefined && line.includes('"cwd"')) {
        const entry = parseObject(line);
        one.cwd = entry === undefined ? undefined : stringField(entry, 'cwd');
    }
}
function addUses(line, one) {
    const parsed = parseTranscriptLine(line);
    if (parsed?.kind === 'call') {
        for (const tool of parsed.tools) {
            if (tool.skill !== undefined) {
                one.skills.add(tool.skill);
            }
            if (tool.agent !== undefined) {
                one.agents.add(tool.agent);
            }
        }
    }
    else if (parsed?.kind === 'prompt') {
        parsed.commands.forEach((command) => one.skills.add(command));
    }
}
async function readOne(source, path, one, chunkBytes) {
    const size = (await source.size(path)) ?? 0;
    for (let offset = 0; offset < size;) {
        const batch = await readLines(source, path, offset, size, chunkBytes);
        for (const line of batch.lines) {
            addCwd(line, one);
            if (mayNameUse(line)) {
                addUses(line, one);
            }
        }
        if (batch.end === offset) {
            break;
        }
        offset = batch.end;
    }
    return size;
}
function addUsedIn(usedIn, names, cwd) {
    for (const name of names) {
        const folders = usedIn.get(name) ?? new Set();
        if (cwd !== undefined) {
            folders.add(cwd);
        }
        usedIn.set(name, folders);
    }
}
/** The transcripts (sessions' and their subagents') changed since `since`, newest first, ties by path. */
async function newestFirst(source, projectsDir, since) {
    const paths = (await discoverTranscripts(source, projectsDir, since)).flatMap((session) => [...session.main, ...session.subagents]);
    const dated = await Promise.all(paths.map(async (path) => ({ path, changedAt: (await source.changedAt(path)) ?? since })));
    return dated.sort((a, b) => b.changedAt - a.changedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/**
 * The skills and agent types used in the transcripts (sessions' and their subagents') written since `window.since` in
 * any project on this machine, read newest first until `window.maxBytes`: a month of a busy machine's transcripts runs
 * to gigabytes. It reads each transcript `chunkBytes` at a time and parses only the lines that can name a use, and
 * the first one carrying a `cwd`, the folder the session started in: a project folder's name in `projectsDir` is a
 * lossy slug (`a/b-c` and `a-b/c` share one), so it cannot say where.
 */
export async function readTranscriptUse(source, projectsDir, window) {
    const skills = new Map();
    const agents = new Map();
    const folders = new Map();
    const dated = await newestFirst(source, projectsDir, window.since);
    let transcripts = 0;
    let bytes = 0;
    for (const { path } of dated) {
        if (bytes >= window.maxBytes) {
            break;
        }
        const one = { cwd: undefined, skills: new Set(), agents: new Set() };
        bytes += await readOne(source, path, one, window.chunkBytes ?? USE_CHUNK_BYTES);
        transcripts += 1;
        addUsedIn(skills, one.skills, one.cwd);
        addUsedIn(agents, one.agents, one.cwd);
        if (one.cwd !== undefined) {
            folders.set(one.cwd, (folders.get(one.cwd) ?? 0) + 1);
        }
    }
    const unread = dated.length - transcripts;
    const oldestRead = dated[transcripts - 1];
    const since = unread === 0 || oldestRead === undefined ? window.since : oldestRead.changedAt;
    return { skills, agents, folders, transcripts, bytes, unread, since };
}
function usedBelow(usedIn, project, platform) {
    const names = [...usedIn].filter(([, folders]) => [...folders].some((folder) => isAtOrBelow(folder, project, platform)));
    return new Set(names.map(([name]) => name));
}
/** The folders none of the others holds, one spelling of each (the last), sorted: where a name was used, without the subfolders. */
export function outermostFolders(folders, platform = process.platform) {
    const unique = [...new Map([...folders].map((folder) => [pathKey(folder, platform), folder])).values()].sort();
    return unique.filter((folder) => !unique.some((other) => other !== folder && isAtOrBelow(folder, other, platform)));
}
/** What the sessions started in `project` or a folder below it used, out of what the transcripts read show. */
export function projectUse(use, project, platform = process.platform) {
    const transcripts = [...use.folders].reduce((sum, [folder, count]) => sum + (isAtOrBelow(folder, project, platform) ? count : 0), 0);
    return { transcripts, skills: usedBelow(use.skills, project, platform), agents: usedBelow(use.agents, project, platform) };
}
