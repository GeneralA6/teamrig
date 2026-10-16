import { claudeProjectsDir, projectTranscriptPath } from "../../budget/discover.js";
import { errorMessage } from "../../core/guards.js";
import { lastClaudeSessionOf } from "../../inbox/marks.js";
import { JsonlMarkLog } from "../../inbox/store.js";
import { resumeVerdict } from "../../hiring/rehire.js";
import { readContextTokens } from "../../refresh/usage.js";
/**
 * Measures whether rehired session `id` resumes its last Claude Code session in `project`: that session is the
 * one that last read its inbox, its transcript is `<projects>/<project slug>/<session>.jsonl`, its idle time
 * that file's last change and its size the context at its last turn. A failed measure starts it fresh, with why.
 */
export async function resumeVerdictOf(runtime, paths, hiring, id, project) {
    try {
        const { marks } = await new JsonlMarkLog(runtime.files, paths.inboxMarks).read();
        const claudeSession = lastClaudeSessionOf(marks, id);
        if (claudeSession === undefined) {
            return resumeVerdict({ claudeSession, changedAt: undefined, tokens: undefined }, hiring, runtime.clock.now());
        }
        const transcript = projectTranscriptPath(claudeProjectsDir(runtime.env, runtime.userHome), project, claudeSession);
        const changedAt = await runtime.transcripts.changedAt(transcript);
        const tokens = changedAt === undefined ? undefined : await readContextTokens(runtime.files, transcript);
        return resumeVerdict({ claudeSession, changedAt, tokens }, hiring, runtime.clock.now());
    }
    catch (error) {
        return { kind: 'fresh', detail: `its last Claude Code session could not be measured: ${errorMessage(error)}` };
    }
}
/** How a fresh open of a rehired session starts: on the handover its retire left, when it left one. */
export function freshOpenOf(from) {
    return from.handover === undefined ? 'open it fresh' : 'open it fresh on its handover';
}
