import { readLines } from "../budget/cursor.js";
import { discoverTranscripts } from "../budget/discover.js";
import { parseTranscriptLine, SKILL_TOOL } from "../budget/line.js";
/** The bytes read at a time: a transcript runs to hundreds of MB, and is never held whole. */
export const SKILL_USE_CHUNK_BYTES = 8 * 1024 * 1024;
/** A cheap test before parsing: only a line naming the Skill tool or a slash command can show a skill in use. */
function mayNameSkill(line) {
    return line.includes(`"${SKILL_TOOL}"`) || line.includes('<command-name>');
}
function addUses(line, used) {
    const parsed = parseTranscriptLine(line);
    if (parsed?.kind === 'call') {
        for (const tool of parsed.tools) {
            if (tool.skill !== undefined) {
                used.add(tool.skill);
            }
        }
    }
    else if (parsed?.kind === 'prompt') {
        parsed.commands.forEach((command) => used.add(command));
    }
}
async function readUses(source, path, used, chunkBytes) {
    const size = (await source.size(path)) ?? 0;
    for (let offset = 0; offset < size;) {
        const batch = await readLines(source, path, offset, size, chunkBytes);
        batch.lines.filter(mayNameSkill).forEach((line) => addUses(line, used));
        if (batch.end === offset) {
            break;
        }
        offset = batch.end;
    }
    return size;
}
/**
 * The skills used in the transcripts (sessions' and their subagents') written since `since` in any project on this
 * machine. It reads each transcript `chunkBytes` at a time and parses only the lines that can name a skill.
 */
export async function readSkillUse(source, projectsDir, since, chunkBytes = SKILL_USE_CHUNK_BYTES) {
    const used = new Set();
    let transcripts = 0;
    let bytes = 0;
    for (const session of await discoverTranscripts(source, projectsDir, since)) {
        for (const path of [...session.main, ...session.subagents]) {
            bytes += await readUses(source, path, used, chunkBytes);
            transcripts += 1;
        }
    }
    return { used, transcripts, bytes };
}
