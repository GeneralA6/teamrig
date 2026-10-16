const DAY_MS = 86_400_000;
/** The verdict with its reason in words, the numbers included, at the clock's `now` (epoch ms). */
export function resumeVerdict(facts, hiring, now) {
    const { claudeSession, changedAt, tokens } = facts;
    if (claudeSession === undefined) {
        return { kind: 'fresh', detail: 'no Claude Code session of it is on record' };
    }
    const last = `its last Claude Code session ${claudeSession}`;
    if (changedAt === undefined) {
        return { kind: 'fresh', detail: `${last} has no transcript in this project folder` };
    }
    if (tokens === undefined) {
        return { kind: 'fresh', detail: `the context of ${last} could not be read` };
    }
    const idle = Math.max(0, now - changedAt);
    const days = (idle / DAY_MS).toFixed(1);
    const size = `${tokens} tokens of context, idle ${days} day(s)`;
    if (tokens > hiring.resumeMaxTokens) {
        return { kind: 'fresh', detail: `${last} holds ${size}: over hiring.resumeMaxTokens ${hiring.resumeMaxTokens}` };
    }
    if (idle > hiring.resumeMaxIdleDays * DAY_MS) {
        return { kind: 'fresh', detail: `${last} holds ${size}: over hiring.resumeMaxIdleDays ${hiring.resumeMaxIdleDays}` };
    }
    return { kind: 'resume', claudeSession, detail: `${last} holds ${size}` };
}
