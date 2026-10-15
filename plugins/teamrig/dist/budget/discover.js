import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from "../core/guards.js";
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
import { nodeTranscriptBytes } from "./cursor.js";
/** The real filesystem. An entry removed while it is listed is left out. */
export const nodeTranscriptFolders = {
    async entries(dir) {
        let names;
        try {
            names = await readdir(dir);
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
                return [];
            }
            throw error;
        }
        const entries = [];
        for (const name of names) {
            try {
                const stats = await stat(join(dir, name));
                entries.push({ name, folder: stats.isDirectory(), changedAt: stats.mtimeMs });
            }
            catch (error) {
                if (errorCode(error) !== 'ENOENT') {
                    throw error;
                }
            }
        }
        return entries;
    },
    async changedAt(path) {
        try {
            const stats = await stat(path);
            return stats.isFile() ? stats.mtimeMs : undefined;
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
                return undefined;
            }
            throw error;
        }
    },
};
export const nodeTranscriptSource = { ...nodeTranscriptBytes, ...nodeTranscriptFolders };
/** Claude Code's folder of project transcripts: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env, userHome) {
    const configDir = env['CLAUDE_CONFIG_DIR']?.trim();
    return join(configDir ? configDir : join(userHome, '.claude'), 'projects');
}
const TRANSCRIPT = '.jsonl';
const SUBAGENTS = 'subagents';
function jsonlChangedSince(entry, since) {
    return !entry.folder && entry.name.endsWith(TRANSCRIPT) && entry.changedAt >= since;
}
/**
 * Every Claude Code session with a transcript written since `since`: `<projects>/<project>/<session>.jsonl`,
 * and its subagents' `<projects>/<project>/<session>/subagents/*.jsonl`, which count as the session's.
 * Sorted by session id, so a run reads them in the same order every time.
 */
export async function discoverTranscripts(folders, projectsDir, since) {
    const found = new Map();
    const sessionOf = (id) => {
        const existing = found.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const created = { main: [], subagents: [] };
        found.set(id, created);
        return created;
    };
    for (const project of await folders.entries(projectsDir)) {
        if (!project.folder) {
            continue;
        }
        const projectDir = join(projectsDir, project.name);
        for (const entry of await folders.entries(projectDir)) {
            const id = entry.folder ? entry.name : entry.name.slice(0, -TRANSCRIPT.length);
            if (!CLAUDE_SESSION_ID.test(id)) {
                continue;
            }
            if (!entry.folder) {
                if (jsonlChangedSince(entry, since)) {
                    sessionOf(id).main.push(join(projectDir, entry.name));
                }
                continue;
            }
            const subagentDir = join(projectDir, entry.name, SUBAGENTS);
            const written = (await folders.entries(subagentDir)).filter((sub) => jsonlChangedSince(sub, since));
            if (written.length > 0) {
                sessionOf(id).subagents.push(...written.map((sub) => join(subagentDir, sub.name)).sort());
            }
        }
    }
    return [...found.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([claudeSession, files]) => ({ claudeSession, main: files.main.sort(), subagents: files.subagents }));
}
/**
 * When any of these Claude Code sessions last wrote its own transcript, in any project folder (epoch
 * ms); undefined when none has one. It checks one path per session and project folder and never lists
 * every transcript, so a hook can afford it.
 */
export async function lastWriteOf(folders, projectsDir, claudeSessions) {
    let last;
    for (const project of await folders.entries(projectsDir)) {
        if (!project.folder) {
            continue;
        }
        for (const id of claudeSessions) {
            const changedAt = await folders.changedAt(join(projectsDir, project.name, `${id}${TRANSCRIPT}`));
            if (changedAt !== undefined && (last === undefined || changedAt > last)) {
                last = changedAt;
            }
        }
    }
    return last;
}
