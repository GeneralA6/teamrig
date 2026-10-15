import { sessionsTitled } from "../hooks/bind.js";
/**
 * Which team session each Claude Code session's use counts for, by the same rules that bind a tab:
 * its inbox mark first, else its title when that is exactly one team session's id or current name.
 * A session that only ran subagents has no title of its own and goes by its mark alone.
 */
export async function attribute(input) {
    const byTeamSession = new Map();
    const outside = [];
    const outsideTitles = [];
    let outsideSessions = 0;
    for (const session of input.sessions) {
        const files = [...session.main, ...session.subagents];
        const marked = input.areaBySession.get(session.claudeSession);
        let id = marked !== undefined && input.roster.ids.includes(marked) ? marked : undefined;
        let title;
        if (id === undefined) {
            title = await titleOfFirst(input, session.main);
            const titled = title === undefined ? [] : sessionsTitled(input.roster, title);
            id = titled.length === 1 ? titled[0] : undefined;
        }
        if (id === undefined) {
            outside.push(...files);
            outsideSessions += 1;
            if (title !== undefined && !outsideTitles.includes(title)) {
                outsideTitles.push(title);
            }
            continue;
        }
        byTeamSession.set(id, [...(byTeamSession.get(id) ?? []), ...files]);
    }
    return { byTeamSession, outside, outsideSessions, outsideTitles };
}
async function titleOfFirst(input, transcripts) {
    for (const transcript of transcripts) {
        const title = await input.titleOf(transcript);
        if (title !== undefined) {
            return title;
        }
    }
    return undefined;
}
