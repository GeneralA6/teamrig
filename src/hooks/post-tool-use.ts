import { isRecord, type JsonRecord } from '../core/guards.ts';

/** What every PostToolUse hook reads from its payload and writes back: the tool's result and a line for the model. */

/** The tool's result as a record: Claude Code may hand it over as the object or as its JSON text. */
export function toolResponseOf(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'string') {
    return isRecord(value) ? value : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A PostToolUse hook's stdout: the line as context for the model after the tool's result. */
export function postToolUseContext(line: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } });
}

/**
 * A PostToolUse hook's stdout that replaces the tool's result, for the model and the transcript alike, with `response`
 * (every key the tool's result has, or Claude Code keeps the original), and the line as context after it.
 */
export function postToolUseReplace(response: JsonRecord, line: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: response, additionalContext: line } });
}
