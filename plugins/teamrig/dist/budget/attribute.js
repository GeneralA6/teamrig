import { sessionsTitled } from "../hooks/bind.js";
import { customTitleOf, TRANSCRIPT_TAIL_BYTES } from "../names/title.js";
const NO_TRANSCRIPTS = { main: [], subagents: [] };
/** The title the user gave a Claude Code session, from its transcript's last `TRANSCRIPT_TAIL_BYTES`. */
export async function transcriptTitleOf(transcripts, path) {
    const size = (await transcripts.size(path)) ?? 0;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    return length === 0 ? undefined : customTitleOf((await transcripts.read(path, size - length, length)).toString('utf8'));
}
/**
 * Which team session each Claude Code session's use counts for, by the same rules that bind a tab:
 * its inbox mark first, else its title when that is exactly one team session's id or current name.
 * A session that only ran subagents has no title of its own and goes by its mark alone.
 */
export async function attribute(input) {
    const byTeamSession = new Map();
    let outside = NO_TRANSCRIPTS;
    const outsideTitles = [];
    let outsideSessions = 0;
    for (const session of input.sessions) {
        const marked = input.areaBySession.get(session.claudeSession);
        let id = marked !== undefined && input.roster.ids.includes(marked) ? marked : undefined;
        let title;
        if (id === undefined) {
            title = await titleOfFirst(input, session.main);
            const titled = title === undefined ? [] : sessionsTitled({ team: input.team, roster: input.roster }, title);
            id = titled.length === 1 ? titled[0] : undefined;
        }
        if (id === undefined) {
            outside = joined(outside, session);
            outsideSessions += 1;
            if (title !== undefined && !outsideTitles.includes(title)) {
                outsideTitles.push(title);
            }
            continue;
        }
        byTeamSession.set(id, joined(byTeamSession.get(id) ?? NO_TRANSCRIPTS, session));
    }
    return { byTeamSession, outside, outsideSessions, outsideTitles };
}
/** Both sets' transcripts, each kind in order. */
function joined(set, more) {
    return { main: [...set.main, ...more.main], subagents: [...set.subagents, ...more.subagents] };
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
