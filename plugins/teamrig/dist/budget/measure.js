import { attribute } from "./attribute.js";
import { discoverTranscripts } from "./discover.js";
import { runMeter } from "./meter.js";
/** The id use outside the team is kept under, in its own store. */
export const OUTSIDE_ID = 'all';
/** The most transcript bytes one meter run reads while catching up. */
export const CATCH_UP_CHUNK_BYTES = 64 * 1024 * 1024;
/** The most meter runs per session in one measure, so a read never runs unbounded. */
export const MAX_RUNS_PER_SESSION = 64;
/** Runs the meter until the session has caught up, at most `maxRuns` times; a run that lost a save race is run again. */
async function meterSession(deps, store, session, transcripts, input) {
    let state = (await store.load(session)).state;
    for (let run = 0; run < input.maxRuns; run += 1) {
        const result = await runMeter({ bytes: deps.transcripts, store, clock: deps.clock }, { session, transcripts, maxBytes: input.chunkBytes });
        if (result.saved) {
            state = result.state;
            if (!result.catchingUp) {
                return { state, behind: false };
            }
        }
    }
    return { state, behind: true };
}
/**
 * Counts every Claude Code session's use up to now into the stores: each team session's transcripts
 * under its id (by its inbox mark, else its title) and everyone else's under `OUTSIDE_ID`.
 */
export async function measure(deps, input) {
    const sessions = await discoverTranscripts(deps.transcripts, input.projectsDir, input.since);
    const found = await attribute({ sessions, roster: input.roster, areaBySession: input.areaBySession, titleOf: (path) => deps.titleOf(path) });
    const bySession = new Map();
    const behind = [];
    for (const id of input.roster.ids) {
        const transcripts = found.byTeamSession.get(id) ?? [];
        if (transcripts.length === 0) {
            bySession.set(id, (await deps.team.load(id)).state);
            continue;
        }
        const metered = await meterSession(deps, deps.team, id, transcripts, input);
        bySession.set(id, metered.state);
        if (metered.behind) {
            behind.push(id);
        }
    }
    const outside = found.outside.length === 0 ? { state: (await deps.outside.load(OUTSIDE_ID)).state, behind: false } : await meterSession(deps, deps.outside, OUTSIDE_ID, found.outside, input);
    if (outside.behind) {
        behind.push(OUTSIDE_ID);
    }
    return { bySession, outside: outside.state, outsideSessions: found.outsideSessions, outsideTitles: found.outsideTitles, behind };
}
