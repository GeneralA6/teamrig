/**
 * What the UserPromptSubmit hook prints: its lines as plain text, which Claude Code adds to the
 * context, or, when it titles the tab, one JSON object that carries the same lines as
 * `additionalContext` and the title as `sessionTitle`. A prompt hook may set the title from Claude
 * Code 2.1.94, older than the oldest teamrig runs on (requirements.ts); a SessionStart hook only from
 * 2.1.152, and only at startup and resume, so the prompt hook is the one that titles a tab.
 */
export function promptOutput(lines, sessionTitle) {
    if (sessionTitle === undefined) {
        return lines;
    }
    const context = lines.length === 0 ? {} : { additionalContext: lines.join('\n') };
    return [JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...context, sessionTitle } })];
}
