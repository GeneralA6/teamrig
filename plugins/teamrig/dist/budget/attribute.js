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
 * A session a peer team's mark binds comes before the title: that team's hooks meter it into its own
 * stores, so it counts neither for this team nor outside, where it would be counted twice on the account.
 * A session that only ran subagents has no title of its own and goes by its mark alone.
 */
export async function attribute(input) {
    const byTeamSession = new Map();
    let outside = NO_TRANSCRIPTS;
    const outsideTitles = [];
    const outsideEach = [];
    let outsideSessions = 0;
    for (const session of input.sessions) {
        const marked = input.areaBySession.get(session.claudeSession);
        let id = marked !== undefined && input.roster.ids.includes(marked) ? marked : undefined;
        if (id === undefined && input.peers.some((peer) => isMarkedBy(peer, session.claudeSession))) {
            continue;
        }
        let title;
        if (id === undefined) {
            title = await titleOfFirst(input, session.main);
            const titled = title === undefined ? [] : sessionsTitled({ team: input.team, roster: input.roster }, title);
            id = titled.length === 1 ? titled[0] : undefined;
        }
        if (id === undefined) {
            outside = joined(outside, session);
            outsideSessions += 1;
            outsideEach.push({ files: session, title });
            if (title !== undefined && !outsideTitles.includes(title)) {
                outsideTitles.push(title);
            }
            continue;
        }
        byTeamSession.set(id, joined(byTeamSession.get(id) ?? NO_TRANSCRIPTS, session));
    }
    return { byTeamSession, outside, outsideSessions, outsideTitles, outsideEach };
}
/** Whether the peer's mark binds the Claude Code session to one of its sessions; a mark of a session it no longer has does not. */
function isMarkedBy(peer, claudeSession) {
    const area = peer.areaBySession.get(claudeSession);
    return area !== undefined && peer.ids.includes(area);
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
