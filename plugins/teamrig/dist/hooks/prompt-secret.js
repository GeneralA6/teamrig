import { KIT_NAME } from "../core/home.js";
function counted(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
function outcomeNote(outcome) {
    switch (outcome.kind) {
        case 'cleaned':
            return outcome.lines + outcome.pastes === 0
                ? undefined
                : `Removed from Claude Code's prompt history: ${counted(outcome.lines, 'line')} and ${counted(outcome.pastes, 'pasted text')} that held it.`;
        case 'retry':
            return "Cleaning it out of Claude Code's prompt history failed; your next prompt tries again.";
        case 'failed':
            return "Cleaning it out of Claude Code's prompt history failed: an earlier prompt that held it may stay in history.jsonl.";
    }
}
/** Why the prompt was stopped: the shapes `found` names, never a value, what to send instead and the clean's outcome. */
export function promptSecretReason(found, outcome) {
    const shapes = [...new Set(found.map(({ description }) => description))].join(', ');
    const note = outcomeNote(outcome);
    const reason = `${KIT_NAME} stopped this prompt before Claude read it: it looks like it holds a secret (${shapes}). Send its name or the file it is kept in instead; the value counts as leaked: rotate it.`;
    return note === undefined ? reason : `${reason} ${note}`;
}
/** The hook's stdout for a stopped prompt: a UserPromptSubmit block that also keeps the prompt out of the transcript. */
export function promptBlockOutput(reason) {
    return JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } });
}
