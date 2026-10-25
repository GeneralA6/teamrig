import { isRecord } from "../core/guards.js";
/** What every PostToolUse hook reads from its payload and writes back: the tool's result and a line for the model. */
/** The tool's result as a record: Claude Code may hand it over as the object or as its JSON text. */
export function toolResponseOf(value) {
    if (typeof value !== 'string') {
        return isRecord(value) ? value : undefined;
    }
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** A PostToolUse hook's stdout: the line as context for the model after the tool's result. */
export function postToolUseContext(line) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } });
}
