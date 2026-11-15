import { claudeProjectsDir, projectTranscriptPath } from "../../budget/discover.js";
import { errorMessage } from "../../core/guards.js";
import { PlainLogFile } from "../../core/log-file.js";
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
        const { marks } = await new JsonlMarkLog(new PlainLogFile(runtime.files, paths.inboxMarks)).read();
        return await claudeSessionVerdict(runtime, hiring, lastClaudeSessionOf(marks, id), project);
    }
    catch (error) {
        return unmeasured(error);
    }
}
/** Whether Claude Code session `claudeSession` (undefined: none on record) in `project` is small and recent enough to resume. */
export async function claudeSessionVerdict(runtime, hiring, claudeSession, project) {
    try {
        const last = claudeSession === undefined ? undefined : await lastSessionOf(runtime, claudeSession, project);
        return resumeVerdict({ claudeSession, changedAt: last?.changedAt, tokens: last?.tokens }, hiring, runtime.clock.now());
    }
    catch (error) {
        return unmeasured(error);
    }
}
function unmeasured(error) {
    return { kind: 'fresh', detail: `its last Claude Code session could not be measured: ${errorMessage(error)}` };
}
/** Measures Claude Code session `claudeSession` in `project`: `<projects>/<project slug>/<session>.jsonl`. It throws when a read fails. */
export function lastSessionOf(runtime, claudeSession, project) {
    return measureTranscript(runtime, projectTranscriptPath(claudeProjectsDir(runtime.env, runtime.userHome), project, claudeSession));
}
/** Measures the Claude Code transcript at `transcript`, in whatever folder it sits. It throws when a read fails. */
export async function measureTranscript(runtime, transcript) {
    const changedAt = await runtime.transcripts.changedAt(transcript);
    const tokens = changedAt === undefined ? undefined : await readContextTokens(runtime.files, transcript);
    return { transcript, changedAt, tokens };
}
/** How a fresh open starts: a rehired session's on the handover its retire left, when it left one; any other's plainly. */
export function freshOpenOf(from) {
    return from?.handover === undefined ? 'open it fresh' : 'open it fresh on its handover';
}
